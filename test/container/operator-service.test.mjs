import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runOperatorCommand } from "../../build/node/operator-cli.js";
import { PostgresKeyAdmission } from "../../build/postgres/keys.js";
import {
	operatorAudience,
	operatorSubject,
	signedOperatorIdentity,
} from "../fixtures/operator-identity.mjs";
import { createPostgresFixture } from "../postgres/fixture.mjs";
import { image, docker, until, verifyImage } from "./runtime-fixture.mjs";

const config = [
	"LEXCERTA_ENVIRONMENT=staging",
	"GOOGLE_CLOUD_PROJECT=fixture-project",
	"LEXCERTA_DATABASE_HOST=ep-fixture-123.us-east-2.aws.neon.tech",
	"LEXCERTA_DATABASE_PASSWORD=synthetic-neon-fixture-password-32",
	`LEXCERTA_BUILD_ID=${"0".repeat(40)}`,
	"API_KEY_PEPPER=synthetic-operator-container-pepper",
	`LEXCERTA_OPERATOR_AUDIENCE=${operatorAudience}`,
	`LEXCERTA_OPERATOR_SUBJECTS=${operatorSubject}`,
	"LEXCERTA_PILOT_CUSTOMERS=pilot-customer",
];

test("operator entrypoint fails safely without configuration or database connectivity at 512 MiB", async () => {
	for (const environment of [[], config])
		await assert.rejects(
			docker(
				"run",
				"--rm",
				"--platform",
				"linux/amd64",
				"--network",
				"none",
				"--memory",
				"512m",
				"--memory-swap",
				"512m",
				"--cpus",
				"1",
				"--read-only",
				"--cap-drop",
				"ALL",
				"--security-opt",
				"no-new-privileges",
				...environment.flatMap((value) => ["-e", value]),
				image,
				"node",
				"build/node/operator-main.js",
			),
			(error) => {
				assert.equal(error.code, 1);
				assert.equal(error.stdout, "");
				assert.equal(error.stderr, '{"event":"startup_failed"}\n');
				return true;
			},
		);
});

test("packaged operator authenticates the CLI, mutates real PostgreSQL and drains active SQL on SIGTERM", async () => {
	const inspected = await verifyImage([
		"node/operator-main.js",
		"node/operator-application.js",
		"node/operator-identity.js",
		"node/operator-http.js",
		"node/operator-cli.js",
		"node/service-http.js",
		"node/service-process.js",
		"node/runtime-config.js",
		"node/neon-database.js",
		"node/gcs-recovery-journal.js",
		"node/http-body.js",
		"node/metadata-token.js",
		"postgres/keys.js",
		"postgres/recovery-journal.js",
		"postgres/source-administration.js",
		"postgres/database.js",
	]);
	const fixture = await createPostgresFixture();
	const directory = await mkdtemp(
		join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "lexcerta-operator-container-"),
	);
	const name = `lexcerta-operator-${randomUUID().slice(0, 8)}`;
	const identity = signedOperatorIdentity();
	try {
		await chmod(directory, 0o755);
		await mkdir(join(directory, "container"));
		await mkdir(join(directory, "fixtures"));
		await copyFile(
			"test/fixtures/recovery-journal.mjs",
			join(directory, "fixtures/recovery-journal.mjs"),
		);
		await copyFile(
			"test/container/operator-fixture.mjs",
			join(directory, "container/operator-fixture.mjs"),
		);
		await writeFile(
			join(directory, "container/certificates.json"),
			JSON.stringify(identity.certificates),
		);
		const connection = new URL(fixture.adminConnection);
		connection.hostname = "host.docker.internal";
		await docker(
			"run",
			"--detach",
			"--platform",
			"linux/amd64",
			"--name",
			name,
			"--memory",
			"512m",
			"--memory-swap",
			"512m",
			"--cpus",
			"1",
			"--pids-limit",
			"128",
			"--read-only",
			"--cap-drop",
			"ALL",
			"--security-opt",
			"no-new-privileges",
			"--add-host",
			"host.docker.internal:host-gateway",
			"-p",
			"127.0.0.1::8080",
			"--mount",
			`type=bind,source=${directory},target=/app/test,readonly`,
			"-e",
			`LEXCERTA_TEST_DATABASE_URL=${connection}`,
			...config.flatMap((value) => ["-e", value]),
			image,
			"node",
			"test/container/operator-fixture.mjs",
		);
		const host = JSON.parse(await docker("inspect", name))[0].HostConfig;
		assert.equal(host.Memory, 536_870_912);
		assert.equal(host.MemorySwap, 536_870_912);
		assert.equal(host.NanoCpus, 1_000_000_000);
		const port = (await docker("port", name, "8080/tcp")).split(":").at(-1);
		const url = `http://127.0.0.1:${port}`;
		await until(async () => (await fetch(`${url}/healthz`).catch(() => undefined))?.status === 200);
		assert.equal((await fetch(`${url}/`, { method: "POST" })).status, 404);
		assert.equal((await fetch(`${url}/v1/keys`, { method: "POST", body: "{}" })).status, 401);
		async function command(args) {
			let stdout = "";
			let stderr = "";
			const code = await runOperatorCommand(
				args,
				{
					LEXCERTA_OPERATOR_URL: operatorAudience,
					LEXCERTA_OPERATOR_INVOKER: "lexcerta-operator@fixture-project.iam.gserviceaccount.com",
				},
				{
					result: (value) => {
						stdout += value;
					},
					diagnostic: (value) => {
						stderr += value;
					},
				},
				{
					token: async () => identity.token(),
					transport: (target, init) => fetch(`${url}${new URL(target).pathname}`, init),
				},
			);
			assert.equal(code, 0);
			assert.equal(stderr.includes("lc_test_"), false);
			return JSON.parse(stdout);
		}
		const issued = await command(["issue", "pilot-customer"]);
		const admission = (credential) =>
			new PostgresKeyAdmission(
				fixture.database,
				"synthetic-operator-container-pepper",
				"test",
			).admit(`Bearer ${credential}`);
		assert.equal((await admission(issued.credential)).kind, "allowed");
		await command(["limits", issued.publicId, "1", "10"]);
		assert.equal((await admission(issued.credential)).kind, "exhausted");
		const rotated = await command(["rotate", issued.publicId]);
		assert.equal((await command(["status", rotated.publicId])).status, "active");
		assert.equal((await command(["status", randomUUID()])).status, "absent");
		assert.equal((await admission(rotated.credential)).kind, "allowed");
		await command(["revoke", rotated.publicId]);
		assert.equal((await admission(rotated.credential)).kind, "unauthorized");
		const removed = await command(["remove-source", "987654"]);
		assert.equal(removed.opinionId, 987654);
		assert.equal(removed.status, "removed");
		assert.equal(removed.pendingDeletionObjects, 0);
		assert.deepEqual(await command(["remove-source", "987654"]), removed);
		assert.deepEqual(
			(
				await fixture.migration.query(
					"SELECT actor_subject, action FROM lexcerta.admin_audit_events WHERE opinion_id = 987654",
				)
			).rows,
			[{ actor_subject: operatorSubject, action: "source_removed" }],
		);
		// A real SQL trigger holds an audit insert, rather than a sleep before
		// dispatch. SIGTERM must drain the same in-flight database mutation.
		await fixture.migration.query(
			"CREATE FUNCTION lexcerta.fixture_slow_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1); RETURN NEW; END $$; CREATE TRIGGER fixture_slow_audit BEFORE INSERT ON lexcerta.admin_audit_events FOR EACH ROW EXECUTE FUNCTION lexcerta.fixture_slow_audit()",
		);
		const pending = command(["issue", "pilot-customer"]);
		void pending.catch(() => undefined);
		await until(async () =>
			(await fixture.inspectActivity()).some(
				(row) =>
					row.usename === fixture.adminRole &&
					row.application_name === "lexcerta-container-operator" &&
					row.wait_event === "PgSleep",
			),
		);
		const signalAt = performance.now();
		await docker("kill", "--signal", "SIGTERM", name);
		const completed = await pending;
		assert.equal(await docker("wait", name), "0");
		assert.ok(performance.now() - signalAt < 10_000);
		assert.equal(JSON.parse(await docker("inspect", name))[0].State.OOMKilled, false);
		assert.equal(
			(
				await fixture.migration.query(
					"SELECT actor_subject FROM lexcerta.admin_audit_events WHERE public_id = $1",
					[completed.publicId],
				)
			).rows[0].actor_subject,
			operatorSubject,
		);
		await until(
			async () =>
				(
					await fixture.migration.query(
						"SELECT 1 FROM pg_stat_activity WHERE usename = $1 AND application_name = 'lexcerta-container-operator'",
						[fixture.adminRole],
					)
				).rowCount === 0,
		);
		const summary = (await docker("logs", name))
			.split("\n")
			.find((line) => line.startsWith('{"fixture_closed"'));
		assert.ok(summary);
		const counts = JSON.parse(summary);
		assert.equal(counts.failures, 0);
		assert.equal(counts.certificate_calls, 1);
		console.log(
			JSON.stringify({
				image: inspected.Id,
				architecture: "amd64",
				memory_limit: 536_870_912,
				cpu_limit: 1,
				fixture_only: true,
				...counts,
			}),
		);
	} finally {
		const logs = await docker("logs", name).catch(() => "");
		await docker("rm", "--force", name).catch(() => undefined);
		await fixture.close();
		await rm(directory, { recursive: true, force: true });
		for (const forbidden of [
			"lc_test_",
			"synthetic-operator-container-pepper",
			"eyJ",
			"BEGIN PUBLIC KEY",
		])
			assert.equal(logs.includes(forbidden), false);
	}
});

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { test } from "node:test";
import { GcsRecoveryJournal } from "../../build/node/gcs-recovery-journal.js";
import { PgDatabase } from "../../build/postgres/database.js";
import { PostgresKeyAdministration } from "../../build/postgres/keys.js";
import { PostgresOpinionSources } from "../../build/postgres/opinions.js";
import { replayRecoveryJournal } from "../../build/postgres/recovery-replay.js";
import { PostgresSourceAdministration } from "../../build/postgres/source-administration.js";
import { withObjects } from "../fixtures/gcs-wire-fixture.mjs";
import { createPostgresFixture } from "../postgres/fixture.mjs";
import { FixtureSourceObjects } from "../postgres/objects-fixture.mjs";
import { docker, until, verifyImage } from "./runtime-fixture.mjs";

const postgresContainer = process.env.LEXCERTA_TEST_POSTGRES_CONTAINER;
assert.match(
	postgresContainer ?? "",
	/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/,
	"name the disposable PostgreSQL fixture container",
);

// All credentials and database names come from createPostgresFixture, which
// rejects remote PostgreSQL URLs. SQL data is piped privately, never logged.
async function restoreSql(connectionString, sql) {
	const connection = new URL(connectionString);
	const args = [
		...(process.env.LEXCERTA_TEST_DOCKER_CONFIG
			? ["--config", process.env.LEXCERTA_TEST_DOCKER_CONFIG]
			: []),
		...(process.env.LEXCERTA_TEST_DOCKER_HOST
			? ["--host", process.env.LEXCERTA_TEST_DOCKER_HOST]
			: []),
		"exec",
		"-i",
		"-e",
		`PGPASSWORD=${decodeURIComponent(connection.password)}`,
		postgresContainer,
		"psql",
		"--host=127.0.0.1",
		`--username=${connection.username}`,
		`--dbname=${connection.pathname.slice(1)}`,
		"--set=ON_ERROR_STOP=1",
		"--no-psqlrc",
		"--quiet",
	];
	await new Promise((resolve, reject) => {
		const process = execFile("docker", args, { timeout: 30_000, maxBuffer: 1_048_576 }, (error) => {
			if (error) reject(new Error("isolated fixture SQL restore failed"));
			else resolve();
		});
		process.stdin.on("error", () => undefined);
		process.stdin.end(sql);
	});
}

async function issue(fixture, journal) {
	const publicId = randomUUID();
	await new PostgresKeyAdministration(fixture.administration, "test", journal).issue({
		publicId,
		customerId: "synthetic-restore-pilot",
		environment: "test",
		hmacSha256Hex: createHmac("sha256", "synthetic-backup-pepper").update(publicId).digest("hex"),
		actorSubject: "synthetic-source-operator",
	});
	return publicId;
}

test("a real PostgreSQL dump restored into a separate database replays post-backup restrictions and stays closed", async () => {
	const image = await verifyImage([
		"postgres/recovery-replay.js",
		"postgres/recovery-scan.js",
		"postgres/recovery-journal.js",
		"postgres/roles.js",
		"postgres/database.js",
		"postgres/migration-connection.js",
		"postgres/keys.js",
		"postgres/source-administration.js",
		"node/gcs-recovery-journal.js",
	]);
	const source = await createPostgresFixture();
	let target;
	try {
		const sourceConnection = new URL(source.migrationConnection);
		const ports = JSON.parse(
			await docker("inspect", "--format", "{{json .NetworkSettings.Ports}}", postgresContainer),
		);
		assert.ok(
			ports["5432/tcp"].some((port) => port.HostPort === (sourceConnection.port || "5432")),
			"dump utility must belong to this loopback PostgreSQL fixture",
		);
		assert.match(
			await docker("exec", postgresContainer, "pg_dump", "--version"),
			/PostgreSQL\) 18\./,
		);
		await withObjects(
			async ({ connection }) => {
				const journal = new GcsRecoveryJournal("fixture", "staging", connection);
				const revokedId = await issue(source, journal);
				const parentId = await issue(source, journal);
				const objects = new FixtureSourceObjects();
				const store = new PostgresOpinionSources(source.database, objects);
				const ownerToken = randomUUID();
				await store.acquireLease({ opinionId: 701, ownerToken, now: new Date() });
				await store.fillLease({
					ownerToken,
					now: new Date(),
					observation: {
						kind: "positive",
						provenance: {
							opinionId: 701,
							clusterId: 108713,
							canonicalUrl: "https://www.courtlistener.com/opinion/108713/fixture/",
						},
						representation: "plain_text",
						sourceText: "synthetic restore opinion text",
					},
				});
				await until(
					async () =>
						!(await source.inspectActivity()).some((row) => row.usename === source.migrationRole),
				);
				const dump = await docker(
					"exec",
					"-e",
					`PGPASSWORD=${decodeURIComponent(sourceConnection.password)}`,
					postgresContainer,
					"pg_dump",
					"--host=127.0.0.1",
					`--username=${sourceConnection.username}`,
					`--dbname=${sourceConnection.pathname.slice(1)}`,
					"--no-owner",
					"--no-acl",
					"--no-comments",
					"--format=plain",
				);
				assert.ok(dump.includes("COPY lexcerta.api_keys"));
				// Mutations happen after the actual snapshot has been collected.
				const admin = new PostgresKeyAdministration(source.administration, "test", journal);
				await admin.revoke(revokedId, "synthetic-source-operator");
				const childId = randomUUID();
				await admin.rotate(parentId, {
					publicId: childId,
					hmacSha256Hex: "b".repeat(64),
					actorSubject: "synthetic-source-operator",
				});
				await admin.revoke(childId, "synthetic-source-operator");
				const remove = new PostgresSourceAdministration(source.administration, "test", journal);
				await remove.remove(701, "synthetic-source-operator");
				await remove.remove(702, "synthetic-source-operator");
				const parentExpiry = (
					await source.migration.query(
						"SELECT expires_at FROM lexcerta.api_keys WHERE public_id=$1",
						[parentId],
					)
				).rows[0].expires_at;

				target = await createPostgresFixture({ initializeSchema: false });
				const targetConnection = new URL(target.migrationConnection);
				assert.notEqual(targetConnection.pathname, sourceConnection.pathname);
				const targetName = targetConnection.pathname.slice(1);
				await target.migration.query(
					`REVOKE CONNECT ON DATABASE ${targetName} FROM PUBLIC, ${target.publicRole}, ${target.adminRole}, ${target.jobRole}`,
				);
				await until(
					async () =>
						!(await target.inspectActivity()).some((row) => row.usename === target.migrationRole),
				);
				await restoreSql(target.migrationConnection, dump);
				const beforeKeys = (
					await target.migration.query("SELECT * FROM lexcerta.api_keys ORDER BY public_id")
				).rows;
				assert.equal(beforeKeys.length, 2);
				assert.ok(beforeKeys.every((key) => key.status === "active"));
				assert.ok(beforeKeys.find((key) => key.public_id === parentId).expires_at > parentExpiry);
				const beforeSource = (
					await target.migration.query(
						"SELECT * FROM lexcerta.opinion_sources WHERE opinion_id=701",
					)
				).rows[0];
				assert.equal(beforeSource.removed_at, null);
				assert.ok(beforeSource.body_key);
				const result = await replayRecoveryJournal({
					database: new PgDatabase(target.migration),
					roles: target.roleNames,
					environment: "staging",
					actorSubject: "synthetic-restore-operator",
					reader: journal,
				});
				assert.equal(result.records, 5);
				assert.equal(result.databaseSealed, true);
				const keys = (
					await target.migration.query("SELECT * FROM lexcerta.api_keys ORDER BY public_id")
				).rows;
				assert.equal(keys.length, 2, "replay must not recreate the post-backup child credential");
				assert.equal(keys.find((key) => key.public_id === revokedId).status, "revoked");
				assert.equal(
					keys.find((key) => key.public_id === parentId).expires_at.toISOString(),
					parentExpiry.toISOString(),
				);
				assert.equal(
					(
						await target.migration.query(
							"SELECT revoked FROM lexcerta.recovered_key_restrictions WHERE public_id=$1",
							[childId],
						)
					).rows[0].revoked,
					true,
				);
				const opinions = (
					await target.migration.query("SELECT * FROM lexcerta.opinion_sources ORDER BY opinion_id")
				).rows;
				assert.deepEqual(
					opinions.map((opinion) => opinion.opinion_id),
					["701", "702"],
				);
				assert.ok(opinions.every((opinion) => opinion.removed_at && opinion.body_key === null));
				assert.deepEqual(opinions[0].state, beforeSource.state);
				for (const pool of [target.publicPool, target.adminPool, target.jobPool])
					await assert.rejects(pool.query("SELECT 1"), { code: "42501" });
				console.log(
					JSON.stringify({
						fixture: "postgresql-backup-restore",
						fixture_only: true,
						image: image.Id,
						snapshot_bytes: Buffer.byteLength(dump),
						snapshot_sha256: createHash("sha256").update(dump).digest("hex"),
						separate_database: true,
						replayed_records: result.records,
						restored_database_sealed: true,
					}),
				);
			},
			{ paginate: true },
		);
	} finally {
		await target?.close();
		await source.close();
	}
});

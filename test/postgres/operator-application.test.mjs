import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { once } from "node:events";
import { after, before, test } from "node:test";
import { createOperatorRequestHandler } from "../../build/node/operator-application.js";
import { createOperatorHttpServer } from "../../build/node/operator-http.js";
import { createOperatorIdentityVerifier } from "../../build/node/operator-identity.js";
import { runOperatorCommand } from "../../build/node/operator-cli.js";
import { PgDatabase } from "../../build/postgres/database.js";
import { PostgresKeyAdministration, PostgresKeyAdmission } from "../../build/postgres/keys.js";
import {
	operatorAudience,
	operatorSubject,
	signedOperatorIdentity,
} from "../fixtures/operator-identity.mjs";
import { poolWithCommitFault } from "./failure-fixture.mjs";
import { createPostgresFixture } from "./fixture.mjs";

let fixture;
const identity = signedOperatorIdentity();
const pepper = "synthetic-operator-fixture-pepper-value";
before(async () => {
	fixture = await createPostgresFixture();
});
after(async () => {
	await fixture?.close();
});

async function service(run, options = {}) {
	const handler = createOperatorRequestHandler({
		database: options.database ?? fixture.administration,
		journal: options.journal ?? fixture.journal,
		identity: createOperatorIdentityVerifier(operatorAudience, [operatorSubject], async () =>
			Response.json(identity.certificates, { headers: { "cache-control": "max-age=3600" } }),
		),
		environment: "test",
		pepper,
		customers: ["pilot-customer"],
	});
	const runtime = createOperatorHttpServer(
		async (request, scope) => {
			const response = await handler(request, scope);
			if (options.dropResponse) scope.close();
			return response;
		},
		{ build: "0".repeat(40) },
	);
	runtime.server.listen(0, "127.0.0.1");
	await once(runtime.server, "listening");
	const url = `http://127.0.0.1:${runtime.server.address().port}`;
	const call = (path, body, overrides = {}) =>
		fetch(`${url}${path}`, {
			method: path.endsWith("/limits") ? "PUT" : "POST",
			headers: {
				"content-type": "application/json",
				"x-lexcerta-operator-token": identity.token(),
				...overrides.headers,
			},
			body: JSON.stringify(body),
		});
	try {
		await run({ call, url });
	} finally {
		await runtime.close();
	}
}
const issueInput = () => ({ publicId: randomUUID(), customerId: "pilot-customer" });
const admission = (token) =>
	new PostgresKeyAdmission(fixture.database, pepper, "test").admit(`Bearer ${token}`);

test("authenticated source removal is repeatable and audits only the verified identity", async () =>
	service(async ({ call }) => {
		const path = "/v1/sources/701/remove";
		const response = await call(path, {}, { headers: { "x-actor-subject": "forged-actor" } });
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("cache-control"), "no-store");
		const removed = await response.json();
		assert.equal(removed.opinionId, 701);
		assert.equal(removed.status, "removed");
		assert.equal(removed.pendingDeletionObjects, 0);
		assert.deepEqual(await (await call(path, {})).json(), removed);
		const audits = (
			await fixture.migration.query(
				"SELECT actor_subject, customer_id, public_id, opinion_id, metadata FROM lexcerta.admin_audit_events WHERE opinion_id = 701",
			)
		).rows;
		assert.deepEqual(audits, [
			{
				actor_subject: operatorSubject,
				customer_id: null,
				public_id: null,
				opinion_id: "701",
				metadata: {},
			},
		]);
	}));

test("source removal rejects unverified actors, unsafe IDs and caller metadata before recording a restriction", async () =>
	service(async ({ call }) => {
		const records = fixture.journal.records.size;
		assert.equal(
			(
				await call(
					"/v1/sources/702/remove",
					{},
					{ headers: { "x-lexcerta-operator-token": "invalid" } },
				)
			).status,
			401,
		);
		for (const body of [
			{ opinionId: 703 },
			{ actorSubject: "forged" },
			{ environment: "production" },
			{ text: "private-source-sentinel" },
		])
			assert.equal((await call("/v1/sources/702/remove", body)).status, 400);
		assert.equal((await call("/v1/sources/9007199254740992/remove", {})).status, 400);
		assert.equal((await call("/v1/sources/0/remove", {})).status, 404);
		assert.equal(fixture.journal.records.size, records);
		assert.equal(
			(
				await fixture.migration.query(
					"SELECT 1 FROM lexcerta.opinion_sources WHERE opinion_id = 702",
				)
			).rowCount,
			0,
		);
	}));

test("a source journal outage returns the correct private recovery action without claiming removal", async () =>
	service(
		async ({ call }) => {
			const response = await call("/v1/sources/703/remove", {});
			assert.equal(response.status, 503);
			assert.deepEqual(await response.json(), {
				error: "outcome_unknown",
				recovery: "repeat_source_removal",
			});
			assert.equal(
				(
					await fixture.migration.query(
						"SELECT 1 FROM lexcerta.opinion_sources WHERE opinion_id = 703",
					)
				).rowCount,
				0,
			);
		},
		{
			journal: {
				environment: "staging",
				async append() {
					throw new Error("private-provider-sentinel");
				},
			},
		},
	));

test("journal failure returns a private uncertain outcome and leaves the key active", async () => {
	const input = issueInput();
	await service(async ({ call }) => {
		assert.equal((await call("/v1/keys", input)).status, 201);
	});
	await service(
		async ({ call }) => {
			const response = await call(`/v1/keys/${input.publicId}/revoke`, {});
			assert.equal(response.status, 503);
			assert.equal(response.headers.get("cache-control"), "no-store");
			assert.deepEqual(await response.json(), {
				error: "outcome_unknown",
				recovery: "reconcile_public_id_before_retry",
			});
		},
		{
			journal: {
				environment: "staging",
				async append() {
					throw new Error("synthetic provider secret must not escape");
				},
			},
		},
	);
	assert.equal(
		(
			await fixture.migration.query("SELECT status FROM lexcerta.api_keys WHERE public_id = $1", [
				input.publicId,
			])
		).rows[0].status,
		"active",
	);
});

test("signed operator issuance persists only HMAC, database expiry and verified actor; limits and revoke take effect", async () =>
	service(async ({ call }) => {
		const input = issueInput();
		const response = await call("/v1/keys", input, {
			headers: { "x-actor-subject": "forged-actor" },
		});
		assert.equal(response.status, 201);
		assert.equal(response.headers.get("cache-control"), "no-store");
		const issued = await response.json();
		assert.equal(issued.publicId, input.publicId);
		assert.match(issued.credential, new RegExp(`^lc_test_${input.publicId}_[A-Za-z0-9_-]{43}$`));
		const row = (
			await fixture.migration.query("SELECT * FROM lexcerta.api_keys WHERE public_id = $1", [
				input.publicId,
			])
		).rows[0];
		assert.equal(
			row.hmac_sha256_hex,
			createHmac("sha256", pepper).update(issued.credential).digest("hex"),
		);
		assert.equal(row.expires_at - row.issued_at, 90 * 86_400_000);
		assert.equal(issued.expiresAt, row.expires_at.toISOString());
		assert.equal(row.minute_limit, 10);
		assert.equal(row.day_limit, 100);
		assert.equal((await admission(issued.credential)).kind, "allowed");
		assert.equal(
			(await call(`/v1/keys/${input.publicId}/limits`, { minute: 1, day: 2 })).status,
			200,
		);
		assert.equal((await admission(issued.credential)).kind, "exhausted");
		assert.equal((await call(`/v1/keys/${input.publicId}/revoke`, {})).status, 200);
		assert.equal((await admission(issued.credential)).kind, "unauthorized");
		const audits = (
			await fixture.migration.query(
				"SELECT action, actor_subject, metadata FROM lexcerta.admin_audit_events WHERE public_id = $1 ORDER BY occurred_at",
				[input.publicId],
			)
		).rows;
		assert.deepEqual(
			audits.map((audit) => audit.action),
			["key_issued", "key_limits_changed", "key_revoked"],
		);
		assert.ok(audits.every((audit) => audit.actor_subject === operatorSubject));
		assert.equal(JSON.stringify([row, audits]).includes(issued.credential), false);
	}));

test("rotation has at most seven days overlap, inherits limits and cannot be replayed", async () =>
	service(async ({ call }) => {
		const input = issueInput();
		const prior = await (
			await call("/v1/keys", { ...input, limits: { minute: 5, day: 20 } })
		).json();
		const publicId = randomUUID();
		const response = await call(`/v1/keys/${input.publicId}/rotate`, { publicId });
		assert.equal(response.status, 201);
		const next = await response.json();
		assert.equal((await admission(prior.credential)).kind, "allowed");
		assert.equal((await admission(next.credential)).kind, "allowed");
		const rows = (
			await fixture.migration.query("SELECT * FROM lexcerta.api_keys WHERE public_id = ANY($1)", [
				[publicId, input.publicId],
			])
		).rows;
		const old = rows.find((row) => row.public_id === input.publicId);
		const fresh = rows.find((row) => row.public_id === publicId);
		const overlap = old.rotation_overlap_until - fresh.issued_at;
		assert.ok(overlap <= 7 * 86_400_000);
		assert.ok(overlap >= 7 * 86_400_000 - 10_000);
		assert.equal(fresh.minute_limit, 5);
		assert.equal(fresh.day_limit, 20);
		assert.equal(fresh.rotation_parent_id, input.publicId);
		for (const replay of [publicId, randomUUID()])
			assert.equal(
				(await call(`/v1/keys/${input.publicId}/rotate`, { publicId: replay })).status,
				409,
			);
		assert.equal(
			(
				await fixture.migration.query(
					"SELECT count(*)::int AS count FROM lexcerta.api_keys WHERE rotation_parent_id = $1",
					[input.publicId],
				)
			).rows[0].count,
			1,
		);
	}));

test("the operator cannot mutate copied production keys or accept caller-selected environment and actor", async () =>
	service(async ({ call }) => {
		const publicId = randomUUID();
		await new PostgresKeyAdministration(
			fixture.administration,
			"production",
			fixture.productionJournal,
		).issue({
			publicId,
			customerId: "pilot-customer",
			environment: "production",
			hmacSha256Hex: "a".repeat(64),
			actorSubject: "production-fixture",
		});
		for (const [action, body] of [
			["revoke", {}],
			["limits", { minute: 1, day: 1 }],
			["rotate", { publicId: randomUUID() }],
		])
			assert.equal((await call(`/v1/keys/${publicId}/${action}`, body)).status, 409);
		for (const extra of [
			{ actorSubject: "forged" },
			{ environment: "production" },
			{ credential: "chosen-secret" },
		])
			assert.equal((await call("/v1/keys", { ...issueInput(), ...extra })).status, 400);
		const row = (
			await fixture.migration.query(
				"SELECT status, minute_limit, rotation_overlap_until FROM lexcerta.api_keys WHERE public_id = $1",
				[publicId],
			)
		).rows[0];
		assert.deepEqual(row, { status: "active", minute_limit: 10, rotation_overlap_until: null });
	}));

test("untrusted tokens, unenrolled customers and malformed or oversized bodies do not create keys", async () =>
	service(async ({ call, url }) => {
		const initial = (
			await fixture.migration.query("SELECT count(*)::int AS count FROM lexcerta.api_keys")
		).rows[0].count;
		for (const token of [
			"",
			identity.token({ sub: "other" }),
			identity.token({ aud: "https://other.run.app" }),
			signedOperatorIdentity().token(),
		])
			assert.equal(
				(await call("/v1/keys", issueInput(), { headers: { "x-lexcerta-operator-token": token } }))
					.status,
				401,
			);
		assert.equal(
			(await call("/v1/keys", { ...issueInput(), customerId: "not-enrolled" })).status,
			403,
		);
		assert.equal(
			(await call("/v1/keys", { ...issueInput(), limits: { minute: 601, day: 100 } })).status,
			400,
		);
		assert.equal(
			(await call("/v1/keys", { ...issueInput(), padding: "x".repeat(4097) })).status,
			413,
		);
		assert.equal(
			(
				await fetch(`${url}/v1/keys`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-lexcerta-operator-token": identity.token(),
					},
					body: Buffer.from([0xff]),
				})
			).status,
			400,
		);
		assert.equal(
			(await fixture.migration.query("SELECT count(*)::int AS count FROM lexcerta.api_keys"))
				.rows[0].count,
			initial,
		);
	}));

test("lost COMMIT acknowledgement never retries issuance; the same public ID conflicts and can be revoked", async () => {
	const input = issueInput();
	let commits = 0;
	const database = new PgDatabase(
		poolWithCommitFault(fixture.adminPool, {
			onCommit: () => {
				commits += 1;
				throw new Error("private-SQL-sentinel");
			},
		}),
	);
	await service(
		async ({ call }) => {
			const response = await call("/v1/keys", input);
			assert.equal(response.status, 503);
			assert.deepEqual(await response.json(), {
				error: "outcome_unknown",
				recovery: "reconcile_public_id_before_retry",
			});
		},
		{ database },
	);
	assert.equal(commits, 1);
	await service(async ({ call }) => {
		assert.equal((await call("/v1/keys", input)).status, 409);
		assert.equal((await call(`/v1/keys/${input.publicId}/revoke`, {})).status, 200);
	});
	assert.equal(
		(
			await fixture.migration.query("SELECT status FROM lexcerta.api_keys WHERE public_id = $1", [
				input.publicId,
			])
		).rows[0].status,
		"revoked",
	);
	assert.equal(
		(
			await fixture.migration.query(
				"SELECT count(*)::int AS count FROM lexcerta.admin_audit_events WHERE public_id = $1 AND action = 'key_issued'",
				[input.publicId],
			)
		).rows[0].count,
		1,
	);
});

test("concurrent duplicate public IDs commit exactly one secret and audit event", async () =>
	service(async ({ call }) => {
		const input = issueInput();
		const replies = await Promise.all([call("/v1/keys", input), call("/v1/keys", input)]);
		assert.deepEqual(replies.map((reply) => reply.status).sort(), [201, 409]);
		assert.equal(
			(
				await fixture.migration.query(
					"SELECT count(*)::int AS count FROM lexcerta.admin_audit_events WHERE public_id = $1",
					[input.publicId],
				)
			).rows[0].count,
			1,
		);
	}));

test("the public database identity cannot execute operator issuance", async () =>
	service(
		async ({ call }) => {
			const input = issueInput();
			assert.equal((await call("/v1/keys", input)).status, 503);
			assert.equal(
				(
					await fixture.migration.query(
						"SELECT count(*)::int AS count FROM lexcerta.api_keys WHERE public_id = $1",
						[input.publicId],
					)
				).rows[0].count,
				0,
			);
		},
		{ database: fixture.database },
	));

test("CLI and actual operator HTTP complete all four commands; dropped output exposes only a recovery ID", async () => {
	const environment = {
		LEXCERTA_OPERATOR_URL: operatorAudience,
		LEXCERTA_OPERATOR_INVOKER: "lexcerta-operator@fixture-project.iam.gserviceaccount.com",
	};
	const run = async (args, url) => {
		let stdout = "";
		let stderr = "";
		let calls = 0;
		const code = await runOperatorCommand(
			args,
			environment,
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
				transport: (target, init) => {
					calls += 1;
					assert.equal(init.redirect, "manual");
					assert.equal(
						init.headers.authorization,
						`Bearer ${init.headers["x-lexcerta-operator-token"]}`,
					);
					return fetch(`${url}${new URL(target).pathname}`, init);
				},
			},
		);
		assert.equal(calls, 1);
		assert.equal(stderr.includes("lc_test_"), false);
		assert.equal(stderr.includes("eyJ"), false);
		return { code, stdout, stderr };
	};
	await service(async ({ url }) => {
		const issued = await run(["issue", "pilot-customer"], url);
		assert.equal(issued.code, 0);
		const first = JSON.parse(issued.stdout);
		const status = await run(["status", first.publicId], url);
		assert.equal(status.code, 0);
		assert.equal(JSON.parse(status.stdout).status, "active");
		assert.equal(status.stdout.includes(first.credential), false);
		const absent = await run(["status", randomUUID()], url);
		assert.equal(absent.code, 0);
		assert.equal(JSON.parse(absent.stdout).status, "absent");
		assert.equal(issued.stdout.trim().split("\n").length, 1);
		assert.equal((await run(["limits", first.publicId, "2", "10"], url)).code, 0);
		const rotated = await run(["rotate", first.publicId], url);
		assert.equal(rotated.code, 0);
		assert.equal((await run(["revoke", JSON.parse(rotated.stdout).publicId], url)).code, 0);
	});
	await service(
		async ({ url }) => {
			const lost = await run(["issue", "pilot-customer"], url);
			assert.equal(lost.code, 1);
			assert.equal(lost.stdout, "");
			assert.match(lost.stderr, /may have committed/);
			const publicId = lost.stderr.match(/public ID: ([a-f0-9-]{36})/)[1];
			assert.equal(
				(
					await fixture.migration.query(
						"SELECT count(*)::int AS count FROM lexcerta.api_keys WHERE public_id = $1",
						[publicId],
					)
				).rows[0].count,
				1,
			);
		},
		{ dropResponse: true },
	);
});

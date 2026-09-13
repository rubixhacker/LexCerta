import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { once } from "node:events";
import { after, before, test } from "node:test";
import { connectPilot, runPilot } from "../../examples/pilot-client.ts";
import { createPublicHttpServer } from "../../build/node/public-http.js";
import { createPublicRequestHandler } from "../../build/node/public-application.js";
import { NodeOpinionNormalizer } from "../../build/node/opinion-normalizer.js";
import { PgDatabase } from "../../build/postgres/database.js";
import { PostgresKeyAdministration } from "../../build/postgres/keys.js";
import { PostgresSourceAdministration } from "../../build/postgres/source-administration.js";
import {
	PostgresCourtListenerCoordinator,
	initializeUpstreamBudget,
} from "../../build/postgres/coordinator.js";
import { createPostgresFixture } from "./fixture.mjs";
import { FixtureSourceObjects } from "./objects-fixture.mjs";

let fixture;
before(async () => {
	fixture = await createPostgresFixture();
});
after(async () => {
	await fixture?.close();
});
const pepper = "synthetic-public-fixture-pepper-value";

async function issue(limit = 10) {
	const publicId = randomUUID();
	const token = `lc_test_${publicId}_${"A".repeat(43)}`;
	await new PostgresKeyAdministration(fixture.administration, "test", fixture.journal).issue({
		publicId,
		customerId: randomUUID(),
		environment: "test",
		actorSubject: "fixture-operator",
		hmacSha256Hex: createHmac("sha256", pepper).update(token).digest("hex"),
		minuteLimit: limit,
		dayLimit: 100,
	});
	return { publicId, token };
}

async function service(run, overrides = {}) {
	const normalizer = new NodeOpinionNormalizer();
	const objects = new FixtureSourceObjects();
	const runtime = createPublicHttpServer(
		createPublicRequestHandler({
			database: fixture.database,
			objects: () => objects,
			normalize: normalizer.normalize,
			pepper,
			environment: "test",
			credentialId: "unavailable-fixture",
			upstreamToken: "synthetic-upstream-token",
			transport: async () => {
				throw new Error("unapproved upstream fixture dispatch");
			},
			...overrides,
		}),
		{ build: "fixture" },
	);
	runtime.server.listen(0, "127.0.0.1");
	await once(runtime.server, "listening");
	try {
		await run(new URL(`http://127.0.0.1:${runtime.server.address().port}/`));
	} finally {
		await runtime.close();
		await normalizer.close();
	}
}

test("the pinned client discovers and calls exactly three tools through real HTTP and Postgres authority", async () => {
	const key = await issue();
	const credentialId = randomUUID();
	await initializeUpstreamBudget(new PgDatabase(fixture.migration), credentialId);
	await fixture.migration.query(
		"UPDATE lexcerta.upstream_budgets SET enabled = true WHERE credential_id = $1",
		[credentialId],
	);
	const coordinator = new PostgresCourtListenerCoordinator(fixture.database, credentialId);
	const syncToken = randomUUID();
	await coordinator.beginQuotaSync({ now: new Date(), syncToken });
	await coordinator.recordQuotaSync({
		now: new Date(),
		syncToken,
		windows: ["user", "citations", "api_usage"].map((scope) => ({
			scope,
			limit: 100,
			remaining: 100,
			rate: "minute",
			windowSeconds: 60,
			resetAt: null,
		})),
	});
	const calls = [];
	const transport = async (request) => {
		assert.equal(request.headers.get("authorization"), "Token synthetic-upstream-token");
		const url = new URL(request.url);
		calls.push(url.pathname);
		if (url.pathname.endsWith("citation-lookup/"))
			return Response.json([
				{
					status: 200,
					normalized_citations: ["410 U.S. 113"],
					clusters: [{ id: 123, absolute_url: "/opinion/123/fixture/" }],
				},
			]);
		if (url.pathname.endsWith("clusters/123/"))
			return Response.json({
				id: 123,
				absolute_url: "/opinion/123/fixture/",
				sub_opinions: ["https://www.courtlistener.com/api/rest/v4/opinions/456/"],
			});
		if (url.pathname.endsWith("opinions/456/"))
			return Response.json({
				id: 456,
				cluster: "https://www.courtlistener.com/api/rest/v4/clusters/123/",
				plain_text: "A public fixture sentence.",
			});
		throw new Error("unexpected fixture request");
	};
	await service(
		async (url) => {
			const client = await connectPilot(url, key.token);
			try {
				const result = await runPilot(client, "410 U.S. 113", "A public fixture sentence.");
				assert.deepEqual(result.tools.tools.map((tool) => tool.name).sort(), [
					"parse_citation",
					"verify_citation",
					"verify_quote",
				]);
				assert.equal(result.citation.structuredContent.outcome, "verified");
				assert.equal(result.quote.structuredContent.outcome, "verified");
				assert.equal(JSON.stringify(result).includes("A public fixture sentence."), false);
				assert.equal(calls.length, 3);
				const removed = await new PostgresSourceAdministration(
					fixture.administration,
					"test",
					fixture.journal,
				).remove(456, "fixture-operator");
				assert.equal(removed.pendingDeletionObjects, 1);
				// Advance this fixture's minute ledger so the next cluster lookup
				// reaches the tombstone instead of stopping at a quota rejection.
				await fixture.migration.query(
					"UPDATE lexcerta.upstream_attempts SET reserved_at = reserved_at - interval '61 seconds', completed_at = completed_at - interval '61 seconds' WHERE credential_id = $1",
					[credentialId],
				);
				const afterRemoval = await client.callTool({
					name: "verify_quote",
					arguments: { citation: "410 U.S. 113", quote: "A public fixture sentence." },
				});
				assert.equal(afterRemoval.structuredContent.outcome, "indeterminate");
				assert.equal(afterRemoval.structuredContent.reason, "upstream_unavailable");
				assert.equal(calls.length, 4, "the cluster is rechecked");
				assert.equal(
					calls.filter((path) => path.endsWith("opinions/456/")).length,
					1,
					"the removed opinion must not be refetched",
				);
				assert.equal(
					(await fetch(new URL("v1/sources/456/remove", url), { method: "POST", body: "{}" }))
						.status,
					404,
				);
				assert.equal(
					(
						await fixture.publicPool.query(
							"SELECT 1 FROM lexcerta.upstream_attempts WHERE credential_id = $1 AND kind <> 'quota_sync'",
							[credentialId],
						)
					).rowCount,
					4,
				);
			} finally {
				await client.close();
			}
		},
		{ credentialId, transport },
	);
});

test("quota exhaustion returns the modern correlated retry error without executing a tool", async () => {
	const key = await issue(1);
	await service(async (url) => {
		const options = {
			method: "POST",
			headers: { authorization: `Bearer ${key.token}`, "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 17, method: "server/discover" }),
		};
		await (await fetch(url, options)).arrayBuffer();
		const response = await fetch(url, options);
		assert.equal(response.status, 429);
		assert.ok(Number(response.headers.get("retry-after")) >= 1);
		assert.deepEqual(await response.json(), {
			jsonrpc: "2.0",
			id: 17,
			error: { code: 1001, message: "API key allowance exhausted" },
		});
		assert.equal(
			(
				await fixture.publicPool.query(
					"SELECT 1 FROM lexcerta.key_admissions WHERE public_id = $1",
					[key.publicId],
				)
			).rowCount,
			1,
		);
	});
});

test("revocation takes effect over HTTP and an environment mismatch cannot admit a test key", async () => {
	const key = await issue();
	await service(async (url) => {
		const client = await connectPilot(url, key.token);
		try {
			await new PostgresKeyAdministration(fixture.administration, "test", fixture.journal).revoke(
				key.publicId,
				"fixture-operator",
			);
			const response = await fetch(url, {
				method: "POST",
				headers: { authorization: `Bearer ${key.token}` },
				body: "{}",
			});
			assert.equal(response.status, 401);
		} finally {
			await client.close();
		}
	});
	const other = await issue();
	await service(
		async (url) => {
			const response = await fetch(url, {
				method: "POST",
				headers: { authorization: `Bearer ${other.token}` },
				body: "{}",
			});
			assert.equal(response.status, 401);
			assert.equal(
				(
					await fixture.publicPool.query(
						"SELECT 1 FROM lexcerta.key_admissions WHERE public_id = $1",
						[other.publicId],
					)
				).rowCount,
				0,
			);
		},
		{ environment: "production" },
	);
});

test("authenticated bodies have a 64KiB boundary and reject invalid UTF8 before MCP dispatch", async () => {
	const key = await issue();
	await service(async (url) => {
		for (const [body, status] of [
			[Buffer.alloc(65_537), 413],
			[Buffer.from([0xff]), 400],
		]) {
			const response = await fetch(url, {
				method: "POST",
				headers: { authorization: `Bearer ${key.token}`, "content-type": "application/json" },
				body,
			});
			assert.equal(response.status, status);
			assert.equal(await response.text(), "");
		}
	});
});

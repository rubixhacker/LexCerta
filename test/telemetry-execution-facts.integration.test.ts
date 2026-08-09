import {
	createExecutionContext,
	env,
	runInDurableObject,
	waitOnExecutionContext,
} from "cloudflare:test";
import {
	CLIENT_CAPABILITIES_META_KEY,
	CLIENT_INFO_META_KEY,
	PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialCourtListenerBudgetState } from "../src/courtlistener/budget.js";
import worker, { type Env } from "../src/worker.js";
import { createLocalAuthFixture, type LocalAuthFixture } from "./fixtures/api-key.js";
import { resetCitationSourceCache } from "./fixtures/citation-source-cache.js";

let fixture: LocalAuthFixture;

beforeEach(async () => {
	fixture = await createLocalAuthFixture({ publicId: `telemetry-facts-${crypto.randomUUID()}` });
	await resetCitationSourceCache(env.DB);
	await env.DB.prepare("DROP TABLE IF EXISTS api_key_records").run();
	await env.DB.prepare(
		"CREATE TABLE api_key_records (public_id TEXT PRIMARY KEY NOT NULL, environment TEXT NOT NULL, hmac_sha256_hex TEXT NOT NULL, status TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT, minute_limit INTEGER NOT NULL DEFAULT 60, day_limit INTEGER NOT NULL DEFAULT 1000, limits_version INTEGER NOT NULL DEFAULT 1)",
	).run();
	await env.DB.prepare(
		"INSERT INTO api_key_records (public_id, environment, hmac_sha256_hex, status, expires_at, revoked_at, minute_limit, day_limit, limits_version) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
	)
		.bind(
			fixture.record.public_id,
			fixture.record.environment,
			fixture.record.hmac_sha256_hex,
			fixture.record.status,
			fixture.record.expires_at,
			fixture.record.revoked_at,
			fixture.record.minute_limit,
			fixture.record.day_limit,
			fixture.record.limits_version,
		)
		.run();
	const coordinator = env.COURTLISTENER_COORDINATOR.getByName(env.COURTLISTENER_CREDENTIAL_ID);
	await runInDurableObject(coordinator, (_instance, state) => {
		state.storage.sql.exec(
			"UPDATE courtlistener_budget_state SET state_json = ?1 WHERE singleton = 1",
			JSON.stringify(initialCourtListenerBudgetState()),
		);
	});
	vi.stubGlobal("fetch", courtListenerFixture);
});

afterEach(() => vi.unstubAllGlobals());

describe("Worker telemetry execution facts", () => {
	it("reports a cold upstream success and warm cache hit through the internal trace boundary", async () => {
		const requests: Request[] = [];
		const first = await fetchCitation(requests);
		const second = await fetchCitation(requests);

		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		const [firstTrace, secondTrace] = requests;
		if (firstTrace === undefined || secondTrace === undefined) {
			throw new Error("telemetry trace requests were not sent");
		}
		expect(await firstTrace.json()).toMatchObject({
			cacheStatus: "miss",
			circuitStatus: "closed",
			keyIdentifier: fixture.record.public_id,
			upstreamStatus: "success",
		});
		expect(await secondTrace.json()).toMatchObject({
			cacheStatus: "hit",
			freshness: "fresh",
			keyIdentifier: fixture.record.public_id,
			upstreamStatus: "not_called",
		});
	});
});

async function fetchCitation(requests: Request[]): Promise<Response> {
	const context = createExecutionContext();
	const response = await worker.fetch(
		citationRequest(),
		{ ...env, API_KEY_PEPPER: fixture.pepper, TELEMETRY_TRACES: traceSink(requests) },
		context,
	);
	await waitOnExecutionContext(context);
	return response;
}

function citationRequest(): Request {
	const protocolVersion = "2026-07-28";
	return new Request("https://mcp.lexcerta.ai/", {
		method: "POST",
		headers: {
			authorization: `Bearer ${fixture.token}`,
			"content-type": "application/json",
			"mcp-method": "tools/call",
			"mcp-name": "verify_citation",
			"mcp-protocol-version": protocolVersion,
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "verify_citation",
				arguments: { citation: "347 U.S. 483" },
				_meta: {
					[PROTOCOL_VERSION_META_KEY]: protocolVersion,
					[CLIENT_INFO_META_KEY]: { name: "telemetry-facts", version: "1.0.0" },
					[CLIENT_CAPABILITIES_META_KEY]: {},
				},
			},
		}),
	});
}

function traceSink(requests: Request[]): NonNullable<Env["TELEMETRY_TRACES"]> {
	return {
		fetch: async (input, init) => {
			requests.push(input instanceof Request ? input : new Request(input, init));
			return new Response(null, { status: 204 });
		},
	};
}

function courtListenerFixture(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	const request = input instanceof Request ? input : new Request(input, init);
	if (request.method === "POST") return Promise.resolve(citationResponse());
	return Promise.resolve(usageResponse());
}

function citationResponse(): Response {
	return Response.json([
		{
			status: 200,
			normalized_citations: ["347 U.S. 483"],
			clusters: [{ id: 108713, absolute_url: "/opinion/108713/brown-v-board-of-education/" }],
		},
	]);
}

function usageResponse(): Response {
	return Response.json({
		current_usage: ["user", "citations", "api_usage"].map((scope) => ({
			scope,
			rate: "minute",
			used: 0,
			limit: 5,
			remaining: 5,
			window_seconds: 60,
			reset_at: "2026-08-09T12:01:00.000Z",
			blocked: false,
		})),
	});
}

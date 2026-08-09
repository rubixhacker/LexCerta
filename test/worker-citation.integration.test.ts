import { SELF, env, runInDurableObject } from "cloudflare:test";
import {
	CLIENT_CAPABILITIES_META_KEY,
	CLIENT_INFO_META_KEY,
	PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialCourtListenerBudgetState } from "../src/courtlistener/budget.js";
import { createLocalAuthFixture } from "./fixtures/api-key.js";

let authorization = "";
const outbound: Request[] = [];
type UsageFixture = "available" | "unavailable";
type CitationFixture = "matched" | "absent" | "rate_limited" | "server" | "transport";
let usageFixture: UsageFixture = "available";
let citationFixture: CitationFixture = "matched";

beforeEach(async () => {
	const fixture = await createLocalAuthFixture({ publicId: `citation-${crypto.randomUUID()}` });
	await env.DB.prepare("DROP TABLE IF EXISTS api_key_records").run();
	await env.DB.prepare(`CREATE TABLE api_key_records (
			public_id TEXT PRIMARY KEY NOT NULL,
			environment TEXT NOT NULL,
			hmac_sha256_hex TEXT NOT NULL,
			status TEXT NOT NULL,
			expires_at TEXT NOT NULL,
			revoked_at TEXT,
			minute_limit INTEGER NOT NULL DEFAULT 60,
			day_limit INTEGER NOT NULL DEFAULT 1000,
			limits_version INTEGER NOT NULL DEFAULT 1
		)`).run();
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
	authorization = `Bearer ${fixture.token}`;
	outbound.length = 0;
	usageFixture = "available";
	citationFixture = "matched";
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

function courtListenerFixture(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	const request = input instanceof Request ? input : new Request(input, init);
	outbound.push(request);
	if (request.method === "GET") {
		return Promise.resolve(
			usageFixture === "available" ? usageResponse() : new Response(null, { status: 503 }),
		);
	}
	if (request.method === "POST") return citationFixtureResponse();
	return Promise.resolve(new Response(null, { status: 405 }));
}

function citationFixtureResponse(): Promise<Response> {
	switch (citationFixture) {
		case "matched":
			return Promise.resolve(citationResponse(200));
		case "absent":
			return Promise.resolve(citationResponse(404));
		case "rate_limited":
			return Promise.resolve(new Response(null, { headers: { "retry-after": "7" }, status: 429 }));
		case "server":
			return Promise.resolve(new Response(null, { status: 503 }));
		case "transport":
			return Promise.reject(new TypeError("fixture transport failure"));
	}
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

function citationResponse(status: 200 | 404): Response {
	return Response.json([
		{
			status,
			normalized_citations: ["347 U.S. 483"],
			clusters:
				status === 200
					? [{ id: 108713, absolute_url: "/opinion/108713/brown-v-board-of-education/" }]
					: [],
		},
	]);
}

function citationRequest(): Request {
	const protocolVersion = "2026-07-28";
	return new Request("https://mcp.lexcerta.ai/", {
		method: "POST",
		headers: {
			authorization,
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
					[CLIENT_INFO_META_KEY]: { name: "workerd-integration", version: "1.0.0" },
					[CLIENT_CAPABILITIES_META_KEY]: {},
				},
			},
		}),
	});
}

describe("Worker citation verification", () => {
	it("returns metadata-only verified evidence with one fixture request per CourtListener endpoint", async () => {
		// Given: an authenticated supported citation and bounded CourtListener usage capacity.
		const request = citationRequest();

		// When: the request crosses the real workerd Worker, Durable Object, and MCP boundary.
		const response = await SELF.fetch(request);

		// Then: it completes from the fixture without retries or sensitive upstream reflection.
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toMatchObject({
			result: {
				isError: false,
				structuredContent: {
					outcome: "verified",
					contractVersion: "1",
					evidence: {
						source: "courtlistener",
						freshness: "fresh",
						cluster: {
							id: 108713,
							canonicalUrl:
								"https://www.courtlistener.com/opinion/108713/brown-v-board-of-education/",
						},
					},
				},
			},
		});
		expect(JSON.stringify(body)).not.toContain("fixture-courtlistener-token");
		expect(outbound).toHaveLength(2);
		expect(outbound.map((request) => request.method)).toEqual(["GET", "POST"]);
		expect(
			outbound.every(
				(request) => request.headers.get("authorization") === "Token fixture-courtlistener-token",
			),
		).toBe(true);
	});

	it.each([
		["explicit CourtListener absence", "available", "absent", "not_found", false, ["GET", "POST"]],
		[
			"CourtListener rate limiting",
			"available",
			"rate_limited",
			"rate_limited",
			true,
			["GET", "POST", "GET"],
		],
		["CourtListener 5xx", "available", "server", "upstream_unavailable", true, ["GET", "POST"]],
		[
			"CourtListener transport failure",
			"available",
			"transport",
			"upstream_unavailable",
			true,
			["GET", "POST"],
		],
		["unknown CourtListener quota", "unavailable", "matched", "quota_unknown", true, ["GET"]],
	] as const)(
		"returns the sanitized contract result for %s without a retry",
		async (_name, usage, citation, reason, isError, methods) => {
			// Given: one deterministic upstream behavior through the real Worker fixture.
			usageFixture = usage;
			citationFixture = citation;

			// When: a supported citation reaches the Worker MCP surface.
			const response = await SELF.fetch(citationRequest());

			// Then: the source-scoped or operational contract is returned with the exact attempt count.
			expect(response.status).toBe(200);
			const body = await response.json();
			if (reason === "not_found") {
				expect(body).toMatchObject({
					result: { isError, structuredContent: { outcome: "not_found" } },
				});
			} else {
				expect(body).toMatchObject({
					result: { isError, structuredContent: { outcome: "indeterminate", reason } },
				});
			}
			expect(outbound.map((request) => request.method)).toEqual(methods);
			if (reason === "not_found") {
				expect(body).toMatchObject({
					result: {
						structuredContent: { evidence: { searchComplete: true, source: "courtlistener" } },
					},
				});
			}
			if (reason === "rate_limited") {
				expect(body).toMatchObject({
					result: { structuredContent: { retry: { action: "retry_later", retryAfterSeconds: 7 } } },
				});
			}
		},
	);

	it("opens the citation circuit after three failures and sends no half-open-ineligible request", async () => {
		// Given: a failing CourtListener citation endpoint with fresh quota state.
		citationFixture = "server";

		// When: four supported citation calls reach the real Worker in circuit succession.
		const responses: Response[] = [];
		for (const _call of [1, 2, 3, 4]) responses.push(await SELF.fetch(citationRequest()));

		// Then: the fourth call is circuit-open and does not send a fourth citation HTTP attempt.
		const last = await responses[3]?.json();
		expect(last).toMatchObject({
			result: {
				isError: true,
				structuredContent: { outcome: "indeterminate", reason: "circuit_open" },
			},
		});
		expect(outbound.map((request) => request.method)).toEqual(["GET", "POST", "POST", "POST"]);
	});
});

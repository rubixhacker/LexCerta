import { SELF, env, runInDurableObject } from "cloudflare:test";
import {
	CLIENT_CAPABILITIES_META_KEY,
	CLIENT_INFO_META_KEY,
	PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialCourtListenerBudgetState } from "../src/courtlistener/budget.js";
import { createLocalAuthFixture } from "./fixtures/api-key.js";
import { resetCitationSourceCache } from "./fixtures/citation-source-cache.js";
import { resetOpinionSourceCache } from "./fixtures/opinion-source-cache.js";

const QUOTE_SENTINEL = "QUOTE_SENTINEL: equal justice under law.";
const OPINION_SENTINEL = "OPINION_SENTINEL: equal justice under law.";
const CLUSTER_ID = 108713;
const OPINION_ID = 2201;
const OPINION_URL = `https://www.courtlistener.com/api/rest/v4/opinions/${OPINION_ID}/`;
let authorization = "";
const outbound: Request[] = [];

afterEach(() => vi.unstubAllGlobals());

beforeEach(async () => {
	const fixture = await createLocalAuthFixture({ publicId: `quote-${crypto.randomUUID()}` });
	await resetCitationSourceCache(env.DB);
	await resetOpinionSourceCache();
	await env.DB.prepare("DROP TABLE IF EXISTS api_key_records").run();
	await env.DB.prepare(`CREATE TABLE api_key_records (
			public_id TEXT PRIMARY KEY NOT NULL, environment TEXT NOT NULL, hmac_sha256_hex TEXT NOT NULL,
			status TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT,
			minute_limit INTEGER NOT NULL DEFAULT 60, day_limit INTEGER NOT NULL DEFAULT 1000,
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
	const coordinator = env.COURTLISTENER_COORDINATOR.getByName(env.COURTLISTENER_CREDENTIAL_ID);
	await runInDurableObject(coordinator, (_instance, state) => {
		state.storage.sql.exec(
			"UPDATE courtlistener_budget_state SET state_json = ?1 WHERE singleton = 1",
			JSON.stringify(initialCourtListenerBudgetState()),
		);
	});
	vi.stubGlobal("fetch", courtListenerFixture);
});

function courtListenerFixture(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	const request = input instanceof Request ? input : new Request(input, init);
	outbound.push(request);
	const { pathname } = new URL(request.url);
	if (pathname.endsWith("/api-usage/")) return Promise.resolve(usageResponse());
	if (pathname.endsWith("/citation-lookup/")) return Promise.resolve(citationResponse());
	if (pathname.endsWith(`/clusters/${CLUSTER_ID}/`)) return Promise.resolve(clusterResponse());
	if (pathname.endsWith(`/opinions/${OPINION_ID}/`)) return Promise.resolve(opinionResponse());
	return Promise.resolve(new Response(null, { status: 404 }));
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

function citationResponse(): Response {
	return Response.json([
		{
			status: 200,
			normalized_citations: ["347 U.S. 483"],
			clusters: [{ id: CLUSTER_ID, absolute_url: "/opinion/108713/example/" }],
		},
	]);
}

function clusterResponse(): Response {
	return Response.json({
		id: CLUSTER_ID,
		absolute_url: "/opinion/108713/example/",
		sub_opinions: [OPINION_URL],
	});
}

function opinionResponse(): Response {
	return Response.json({
		id: OPINION_ID,
		cluster: `https://www.courtlistener.com/api/rest/v4/clusters/${CLUSTER_ID}/`,
		html_with_citations: `<p>${QUOTE_SENTINEL} ${OPINION_SENTINEL}</p>`,
	});
}

function quoteRequest(
	input: { readonly citation?: string; readonly quote?: string } = {},
): Request {
	const protocolVersion = "2026-07-28";
	return new Request("https://mcp.lexcerta.ai/", {
		method: "POST",
		headers: {
			authorization,
			"content-type": "application/json",
			"mcp-method": "tools/call",
			"mcp-name": "verify_quote",
			"mcp-protocol-version": protocolVersion,
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "verify_quote",
				arguments: {
					citation: input.citation ?? "347 U.S. 483",
					quote: input.quote ?? QUOTE_SENTINEL,
				},
				_meta: {
					[PROTOCOL_VERSION_META_KEY]: protocolVersion,
					[CLIENT_INFO_META_KEY]: { name: "issue-7-workerd", version: "1.0.0" },
					[CLIENT_CAPABILITIES_META_KEY]: {},
				},
			},
		}),
	});
}

describe("Issue 7 quote verification", () => {
	it("returns metadata-only verified evidence through real workerd bindings", async () => {
		// Given: an authenticated quote request and one fixture-backed CourtListener opinion match.
		const request = quoteRequest();

		// When: the request passes through the Worker, coordinator, and MCP boundary.
		const response = await SELF.fetch(request);

		// Then: a verified result identifies only source metadata and made one attempt per source request.
		expect(response.status).toBe(200);
		const body = JSON.stringify(await response.json());
		expect(body).toContain('"outcome":"verified"');
		expect(body).toContain(`"id":${OPINION_ID}`);
		expect(body).toContain('"representation":"html_with_citations"');
		expect(body).not.toContain(QUOTE_SENTINEL);
		expect(body).not.toContain(OPINION_SENTINEL);
		expect(outbound.map((request) => request.method)).toEqual(["GET", "POST", "GET", "GET"]);
	});

	it("reuses a fresh durable opinion across separately constructed requests", async () => {
		// Given: a completed quote verification whose citation result remains cached.
		await SELF.fetch(quoteRequest());

		// When: the same authenticated MCP request is made again.
		const response = await SELF.fetch(quoteRequest());

		// Then: the repeat re-reads the cluster but serves opinion text from durable R2 evidence.
		expect(response.status).toBe(200);
		expect(JSON.stringify(await response.json())).toContain('"outcome":"verified"');
		expect(outbound.map((request) => new URL(request.url).pathname)).toEqual([
			"/api/rest/v4/api-usage/",
			"/api/rest/v4/citation-lookup/",
			`/api/rest/v4/clusters/${CLUSTER_ID}/`,
			`/api/rest/v4/opinions/${OPINION_ID}/`,
			`/api/rest/v4/clusters/${CLUSTER_ID}/`,
		]);
	});

	it("coalesces the opinion fetch for concurrent cold quote verifications", async () => {
		// Given: two identical cold authenticated quote-verification requests.
		const first = quoteRequest();
		const second = quoteRequest();

		// When: both requests reach the real Worker concurrently.
		const responses = await Promise.all([SELF.fetch(first), SELF.fetch(second)]);

		// Then: both callers complete after independent cluster reads and one opinion cache fill.
		await expect(Promise.all(responses.map((response) => response.json()))).resolves.toEqual(
			expect.arrayContaining([
				expect.objectContaining({ result: expect.objectContaining({ isError: false }) }),
				expect.objectContaining({ result: expect.objectContaining({ isError: false }) }),
			]),
		);
		expect(
			outbound.filter((request) => new URL(request.url).pathname.includes("/clusters/")),
		).toHaveLength(2);
		expect(
			outbound.filter((request) => new URL(request.url).pathname.includes("/opinions/")),
		).toHaveLength(1);
	});

	it.each([20, 10_000])("accepts the exact quote length boundary %i", async (length) => {
		const response = await SELF.fetch(quoteRequest({ quote: "q".repeat(length) }));
		expect(response.status).toBe(200);
		expect(JSON.stringify(await response.json())).toContain('"outcome":"not_found"');
		expect(outbound).toHaveLength(4);
	});

	it.each([
		{ citation: "", quote: QUOTE_SENTINEL },
		{ citation: "c".repeat(257), quote: QUOTE_SENTINEL },
		{ citation: "347 U.S. 483", quote: "q".repeat(19) },
		{ citation: "347 U.S. 483", quote: "q".repeat(10_001) },
	] as const)("rejects quote input bounds before CourtListener work", async (input) => {
		// Given: an authenticated request outside one citation or quote input boundary.
		const request = quoteRequest(input);

		// When: MCP validation handles the request after key admission.
		const response = await SELF.fetch(request);

		// Then: validation rejects it without any CourtListener transmission.
		expect(response.status).toBe(200);
		expect(JSON.stringify(await response.json())).toContain('"isError":true');
		expect(outbound).toHaveLength(0);
	});
});

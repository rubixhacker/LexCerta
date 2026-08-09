import { SELF } from "cloudflare:test";
import {
	CLIENT_CAPABILITIES_META_KEY,
	CLIENT_INFO_META_KEY,
	PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setupQuoteWorker } from "./fixtures/issue-7-quote-worker.js";

const PROTOCOL_VERSION = "2026-07-28";
const OPINION_ID = 91001;
const CLUSTER_ID = 108713;
const MAX_QUOTE = "quote-data".repeat(1_000);

afterEach(() => vi.unstubAllGlobals());

function discoveryRequest(source: Request): Request {
	return new Request("https://mcp.lexcerta.ai/", {
		method: "POST",
		headers: {
			authorization: source.headers.get("authorization") ?? "",
			"content-type": "application/json",
			"mcp-method": "server/discover",
			"mcp-protocol-version": PROTOCOL_VERSION,
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "server/discover",
			params: {
				_meta: {
					[PROTOCOL_VERSION_META_KEY]: PROTOCOL_VERSION,
					[CLIENT_INFO_META_KEY]: { name: "runtime-conformance", version: "1.0.0" },
					[CLIENT_CAPABILITIES_META_KEY]: {},
				},
			},
		}),
	});
}

function subscriptionRequest(source: Request): Request {
	return new Request("https://mcp.lexcerta.ai/", {
		method: "POST",
		headers: {
			authorization: source.headers.get("authorization") ?? "",
			"content-type": "application/json",
			"mcp-method": "subscriptions/listen",
			"mcp-protocol-version": PROTOCOL_VERSION,
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "subscriptions/listen",
			params: {
				_meta: {
					[PROTOCOL_VERSION_META_KEY]: PROTOCOL_VERSION,
					[CLIENT_INFO_META_KEY]: { name: "runtime-conformance", version: "1.0.0" },
					[CLIENT_CAPABILITIES_META_KEY]: {},
				},
			},
		}),
	});
}

function sourceUrls(outbound: readonly Request[]): string[] {
	return outbound.map((request) => new URL(request.url).toString());
}

describe("Worker runtime conformance", () => {
	it("serves the modern discovery contract through the official handler in workerd", async () => {
		// Given: a fixture-only authenticated Worker request.
		const fixture = await setupQuoteWorker({ opinions: [] });

		// When: the modern discovery request crosses the complete Worker boundary.
		const response = await SELF.fetch(discoveryRequest(fixture.request()));

		// Then: the official handler exposes only the stateless supported protocol and tools capability.
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			jsonrpc: "2.0",
			id: 1,
			result: { supportedVersions: [PROTOCOL_VERSION], capabilities: { tools: {} } },
		});
		expect(fixture.outbound).toHaveLength(0);
	});

	it("normalizes the maximum quote through parse5 without exposing fixture source text", async () => {
		// Given: a fixture-only canonical HTML representation containing a maximum contract quote.
		const fixture = await setupQuoteWorker({
			opinions: [
				{
					id: OPINION_ID,
					body: {
						id: OPINION_ID,
						cluster: `https://www.courtlistener.com/api/rest/v4/clusters/${CLUSTER_ID}/`,
						html_with_citations: `<article><p>${MAX_QUOTE}</p><script>excluded fixture</script></article>`,
					},
				},
			],
		});

		// When: the quote request runs through the real workerd Worker and fixed upstream fixtures.
		const response = await SELF.fetch(fixture.request(MAX_QUOTE));

		// Then: parse5-backed canonical text verifies, provenance is metadata-only, and outbound stays bounded.
		expect(response.status).toBe(200);
		const body = JSON.stringify(await response.json());
		expect(body).toContain('"outcome":"verified"');
		expect(body).toContain('"representation":"html_with_citations"');
		expect(body).not.toContain(MAX_QUOTE);
		expect(body).not.toContain("excluded fixture");
		expect(sourceUrls(fixture.outbound)).toEqual([
			"https://www.courtlistener.com/api/rest/v4/api-usage/",
			"https://www.courtlistener.com/api/rest/v4/citation-lookup/",
			`https://www.courtlistener.com/api/rest/v4/clusters/${CLUSTER_ID}/`,
			`https://www.courtlistener.com/api/rest/v4/opinions/${OPINION_ID}/`,
		]);
	});

	it("rejects statelessly excluded subscription traffic without an outbound request", async () => {
		// Given: an authenticated fixture request whose JSON-RPC method attempts subscriptions.
		const fixture = await setupQuoteWorker({ opinions: [] });
		const subscription = subscriptionRequest(fixture.request());

		// When: it reaches the public Worker route.
		const response = await SELF.fetch(subscription);

		// Then: the response is bounded rejection, never a persistent SSE stream or source request.
		expect(response.status).toBe(400);
		expect(response.headers.get("content-type") ?? "").not.toContain("text/event-stream");
		expect(fixture.outbound).toHaveLength(0);
	});
});

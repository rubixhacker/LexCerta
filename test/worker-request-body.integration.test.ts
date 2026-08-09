import { SELF, env } from "cloudflare:test";
import {
	CLIENT_CAPABILITIES_META_KEY,
	CLIENT_INFO_META_KEY,
	PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_MCP_REQUEST_BODY_BYTES } from "../src/request-body.js";
import { createLocalAuthFixture } from "./fixtures/api-key.js";

const encoder = new TextEncoder();
let authorization = "";
let upstreamCalls = 0;

beforeEach(async () => {
	const fixture = await createLocalAuthFixture({ publicId: `body-${crypto.randomUUID()}` });
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
	upstreamCalls = 0;
	vi.stubGlobal("fetch", () => {
		upstreamCalls += 1;
		return Promise.resolve(new Response(null, { status: 500 }));
	});
});

afterEach(() => vi.unstubAllGlobals());

function mcpRequest(body: BodyInit, contentLength?: string, name = "verify_citation"): Request {
	const protocolVersion = "2026-07-28";
	return new Request("https://mcp.lexcerta.ai/", {
		method: "POST",
		headers: {
			authorization,
			"content-type": "application/json",
			"mcp-method": "tools/call",
			"mcp-name": name,
			"mcp-protocol-version": protocolVersion,
			...(contentLength === undefined ? {} : { "content-length": contentLength }),
		},
		body,
	});
}

function modernBody(
	method: string,
	name: string,
	argumentsValue: Readonly<Record<string, string>>,
): string {
	const protocolVersion = "2026-07-28";
	return JSON.stringify({
		jsonrpc: "2.0",
		id: 1,
		method,
		params: {
			name,
			arguments: argumentsValue,
			_meta: {
				[PROTOCOL_VERSION_META_KEY]: protocolVersion,
				[CLIENT_INFO_META_KEY]: { name: "workerd-integration", version: "1.0.0" },
				[CLIENT_CAPABILITIES_META_KEY]: {},
			},
		},
	});
}

function oversizedStream() {
	let cancelled = false;
	const bytes = encoder.encode("x".repeat(MAX_MCP_REQUEST_BODY_BYTES + 1));
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes.slice(0, 32));
			controller.enqueue(bytes.slice(32));
		},
		cancel() {
			cancelled = true;
		},
	});
	return { stream, wasCancelled: () => cancelled };
}

function expectPayloadTooLarge(response: Response): Promise<void> {
	expect(response.status).toBe(413);
	expect(response.headers.get("cache-control")).toBe("no-store");
	return expect(response.text()).resolves.toBe("");
}

describe("Worker request body boundary", () => {
	it("charges and rejects a declared oversized request before MCP or CourtListener", async () => {
		// Given: the only allowed request declares a payload larger than the hard cap.
		await env.DB.prepare("UPDATE api_key_records SET minute_limit = 1, day_limit = 1").run();
		const oversized = mcpRequest("{}", String(MAX_MCP_REQUEST_BODY_BYTES + 1));

		// When: it reaches the authenticated Worker boundary.
		const rejected = await SELF.fetch(oversized);
		const exhausted = await SELF.fetch(
			mcpRequest(modernBody("tools/call", "verify_citation", { citation: "347 U.S. 483" })),
		);

		// Then: it is bodyless/no-store, incurs admission, and never invokes an upstream fetch.
		await expectPayloadTooLarge(rejected);
		expect(exhausted.status).toBe(429);
		expect(upstreamCalls).toBe(0);
	});

	it.each([undefined, "1"] as const)(
		"rejects a %s oversized streamed body before dispatch",
		async (contentLength) => {
			// Given: an oversized stream with either no Content-Length or a lying short one.
			const source = oversizedStream();

			// When: it crosses the authenticated Worker boundary.
			const response = await SELF.fetch(mcpRequest(source.stream, contentLength));

			// Then: the response is 413 and no upstream request occurs.
			await expectPayloadTooLarge(response);
			expect(upstreamCalls).toBe(0);
		},
	);

	it("preserves a small valid MCP body for the SDK handler", async () => {
		// Given: a bounded modern parse-citation request.
		const request = mcpRequest(
			modernBody("tools/call", "parse_citation", { citation: "347 U.S. 483" }),
			undefined,
			"parse_citation",
		);

		// When: the Worker buffers and rebuilds it before SDK dispatch.
		const response = await SELF.fetch(request);

		// Then: the SDK still returns the versioned parser result without an upstream fetch.
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			result: {
				structuredContent: { outcome: "parsed", citation: { normalized: "347 U.S. 483" } },
			},
		});
		expect(upstreamCalls).toBe(0);
	});

	it("accepts the maximum Unicode quote body below the byte cap", async () => {
		// Given: a contract-valid 10,000-character quote whose UTF-8 body is well below the cap.
		const quote = "字".repeat(10_000);
		const request = mcpRequest(
			modernBody("tools/call", "verify_quote", { citation: "347 U.S. 483", quote }),
			undefined,
			"verify_quote",
		);

		// When: the Worker buffers and rebuilds the complete Unicode payload.
		const response = await SELF.fetch(request);

		// Then: the SDK receives it and reaches the functional quote-verification failure boundary.
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			result: {
				isError: true,
				structuredContent: { outcome: "indeterminate", reason: "upstream_unavailable" },
			},
		});
		expect(upstreamCalls).toBe(0);
	});

	it("preserves the SDK malformed-request response below the cap", async () => {
		// Given: a bounded request with the modern routing envelope but invalid JSON.
		const request = mcpRequest("{", undefined, "parse_citation");

		// When: the Worker buffers and forwards it to the SDK.
		const response = await SELF.fetch(request);

		// Then: the SDK's normal bad-request response remains observable and no upstream call occurs.
		expect(response.status).toBe(400);
		expect(upstreamCalls).toBe(0);
	});
});

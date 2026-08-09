import { SELF, env } from "cloudflare:test";
import {
	CLIENT_CAPABILITIES_META_KEY,
	CLIENT_INFO_META_KEY,
	PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it } from "vitest";
import { createLocalAuthFixture } from "./fixtures/api-key.js";

let authorization = "";

beforeEach(async () => {
	const fixture = await createLocalAuthFixture({ publicId: `routing-${crypto.randomUUID()}` });
	await env.DB.prepare("DROP TABLE IF EXISTS api_key_records").run();
	await env.DB.prepare(`CREATE TABLE api_key_records (
			public_id TEXT PRIMARY KEY NOT NULL,
			environment TEXT NOT NULL,
			hmac_sha256_hex TEXT NOT NULL,
			status TEXT NOT NULL,
			expires_at TEXT NOT NULL,
			revoked_at TEXT,
			minute_limit INTEGER NOT NULL DEFAULT 60,
			day_limit INTEGER NOT NULL DEFAULT 1000
		)`).run();
	await env.DB.prepare(
		"INSERT INTO api_key_records (public_id, environment, hmac_sha256_hex, status, expires_at, revoked_at, minute_limit, day_limit) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
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
		)
		.run();
	authorization = `Bearer ${fixture.token}`;
});

type ModernMcpRequestOptions = {
	readonly arguments?: Readonly<Record<string, string>>;
	readonly name?: string;
	readonly protocolVersion?: string;
};

function modernMcpRequest(method: string, options: ModernMcpRequestOptions = {}): Request {
	const protocolVersion = options.protocolVersion ?? "2026-07-28";
	const headers = new Headers({
		authorization,
		"content-type": "application/json",
		"mcp-method": method,
		"mcp-protocol-version": protocolVersion,
	});
	if (options.name !== undefined) headers.set("mcp-name", options.name);
	return new Request("https://mcp.lexcerta.ai/", {
		method: "POST",
		headers,
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method,
			params: {
				...(options.name === undefined ? {} : { name: options.name }),
				...(options.arguments === undefined ? {} : { arguments: options.arguments }),
				_meta: {
					[PROTOCOL_VERSION_META_KEY]: protocolVersion,
					[CLIENT_INFO_META_KEY]: { name: "workerd-integration", version: "1.0.0" },
					[CLIENT_CAPABILITIES_META_KEY]: {},
				},
			},
		}),
	});
}

describe("Worker HTTP routing", () => {
	it("returns unauthenticated process status when GET targets healthz", async () => {
		// Given: a Worker with no dependency access.
		const request = new Request("https://mcp.lexcerta.ai/healthz");

		// When: an unauthenticated health probe reaches the public endpoint.
		const response = await SELF.fetch(request);

		// Then: it exposes only basic status and a non-sensitive build identifier.
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: "ok", build: "local" });
	});

	it("rejects a non-POST root request with method not allowed", async () => {
		// Given: the canonical MCP root endpoint.
		const request = new Request("https://mcp.lexcerta.ai/");

		// When: it receives a GET request.
		const response = await SELF.fetch(request);

		// Then: the Worker does not expose a stream or browser-oriented endpoint.
		expect(response.status).toBe(405);
		expect(response.headers.get("allow")).toBe("POST");
	});

	it("returns the generic authentication failure when POST has no Bearer credential", async () => {
		// Given: an MCP-shaped POST without an Authorization header.
		const request = new Request("https://mcp.lexcerta.ai/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover" }),
		});

		// When: it reaches the public MCP endpoint.
		const response = await SELF.fetch(request);

		// Then: missing credentials are rejected before protocol dispatch.
		expect(response.status).toBe(401);
		expect(await response.text()).toBe('{"error":"Unauthorized"}');
	});

	it("discovers only the modern protocol and tools capability when headers and metadata agree", async () => {
		// Given: a valid Bearer credential and a self-contained modern discovery request.
		const request = modernMcpRequest("server/discover");

		// When: it reaches the authenticated MCP root.
		const response = await SELF.fetch(request);

		// Then: the SDK advertises the 2026-only tools server without initialization state.
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			jsonrpc: "2.0",
			id: 1,
			result: {
				supportedVersions: ["2026-07-28"],
				capabilities: { tools: {} },
				instructions: expect.any(String),
			},
		});
	});

	it("rejects a conflicting Mcp-Method header before MCP dispatch", async () => {
		// Given: a modern discovery request whose routing header names a different method.
		const request = modernMcpRequest("server/discover");
		request.headers.set("mcp-method", "tools/list");

		// When: it reaches the authenticated MCP root.
		const response = await SELF.fetch(request);

		// Then: header and body disagreement is an HTTP bad request.
		expect(response.status).toBe(400);
	});

	it("rejects a modern request without the required protocol version header", async () => {
		// Given: an authenticated discovery request missing its modern protocol routing header.
		const request = modernMcpRequest("server/discover");
		request.headers.delete("mcp-protocol-version");

		// When: it reaches the authenticated MCP endpoint.
		const response = await SELF.fetch(request);

		// Then: the Worker refuses the request before SDK dispatch.
		expect(response.status).toBe(400);
	});

	it("delegates unsupported protocol versions to the official JSON-RPC handler", async () => {
		// Given: an authenticated discovery request that presents an unsupported protocol header.
		const request = modernMcpRequest("server/discover", {
			protocolVersion: "2025-06-18",
		});

		// When: it reaches the modern MCP endpoint.
		const response = await SELF.fetch(request);

		// Then: the SDK preserves its protocol error contract instead of an empty boundary response.
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: { code: -32022 },
			id: 1,
			jsonrpc: "2.0",
		});
	});

	it("rejects a modern request carrying a session identifier", async () => {
		// Given: an authenticated otherwise-valid discovery request attempting to resume session state.
		const request = modernMcpRequest("server/discover");
		request.headers.set("mcp-session-id", "forbidden-session");

		// When: it reaches the stateless MCP endpoint.
		const response = await SELF.fetch(request);

		// Then: session-oriented protocol traffic is not accepted.
		expect(response.status).toBe(400);
	});

	it("rejects an authenticated subscriptions/listen request before an SSE stream opens", async () => {
		// Given: an authenticated modern request for the excluded subscription capability.
		const request = modernMcpRequest("subscriptions/listen");

		// When: it reaches the stateless MCP endpoint.
		const response = await SELF.fetch(request);

		// Then: no authenticated persistent SSE channel is exposed.
		expect(response.status).toBe(400);
		expect(response.headers.get("content-type") ?? "").not.toContain("text/event-stream");
	});

	it("rejects an authenticated subscriptions/listen request without its routing header", async () => {
		// Given: a modern subscription request with no Mcp-Method routing header.
		const request = modernMcpRequest("subscriptions/listen");
		request.headers.delete("mcp-method");

		// When: it reaches the stateless MCP endpoint.
		const response = await SELF.fetch(request);

		// Then: a missing header cannot bypass the no-subscriptions boundary.
		expect(response.status).toBe(400);
		expect(response.headers.get("content-type") ?? "").not.toContain("text/event-stream");
	});

	it("keeps protocol-boundary validation behind generic authentication", async () => {
		// Given: an unauthenticated POST with both malformed protocol routing and a session header.
		const request = new Request("https://mcp.lexcerta.ai/", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"mcp-session-id": "forbidden-session",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover" }),
		});

		// When: it reaches the public Worker endpoint.
		const response = await SELF.fetch(request);

		// Then: the client receives the same generic unauthorized response before protocol details.
		expect(response.status).toBe(401);
		expect(await response.text()).toBe('{"error":"Unauthorized"}');
	});

	it("rejects a legacy initialize request instead of creating session state", async () => {
		// Given: a valid credential with a 2025-style initialize body and no modern envelope headers.
		const request = new Request("https://mcp.lexcerta.ai/", {
			method: "POST",
			headers: { authorization, "content-type": "application/json" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: { protocolVersion: "2025-06-18", capabilities: {} },
			}),
		});

		// When: the request reaches the sole MCP endpoint.
		const response = await SELF.fetch(request);

		// Then: strict modern-only mode refuses the legacy initialization exchange.
		expect(response.status).toBe(400);
	});

	it("charges an authenticated POST before protocol validation and returns a JSON-RPC 429", async () => {
		// Given: the authoritative D1 allowance is one request in both rolling windows.
		await env.DB.prepare("UPDATE api_key_records SET minute_limit = 1, day_limit = 2").run();
		const malformed = new Request("https://mcp.lexcerta.ai/", {
			method: "POST",
			headers: {
				authorization,
				"content-type": "application/json",
				"mcp-method": "server/discover",
				"mcp-protocol-version": "2026-07-28",
			},
			body: "{",
		});

		// When: malformed protocol traffic consumes the only admission unit, then another request arrives.
		const first = await SELF.fetch(malformed);
		const secondRequest = modernMcpRequest("server/discover");
		const second = await SELF.fetch(secondRequest);

		// Then: the first request fails at the protocol seam, and the next request is exhausted with its ID.
		expect(first.status).toBe(400);
		expect(second.status).toBe(429);
		expect(second.headers.get("retry-after")).toBe("60");
		expect(await second.json()).toEqual({
			jsonrpc: "2.0",
			id: 1,
			error: { code: -32029, message: "API key allowance exhausted" },
		});
	});

	it("does not charge an unauthenticated health probe", async () => {
		// Given: a fresh key with one request in each rolling window.
		await env.DB.prepare("UPDATE api_key_records SET minute_limit = 1, day_limit = 1").run();

		// When: an unauthenticated health probe runs before the authenticated request.
		const health = await SELF.fetch(new Request("https://mcp.lexcerta.ai/healthz"));
		const authenticated = await SELF.fetch(modernMcpRequest("server/discover"));

		// Then: health is available and the authenticated request still receives its one admission.
		expect(health.status).toBe(200);
		expect(authenticated.status).toBe(200);
	});
});

import { SELF, env } from "cloudflare:test";
import {
	CLIENT_CAPABILITIES_META_KEY,
	CLIENT_INFO_META_KEY,
	PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createLocalAuthFixture } from "./fixtures/api-key.js";

let authorization = "";

beforeEach(async () => {
	const fixture = await createLocalAuthFixture({ publicId: `tools-${crypto.randomUUID()}` });
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

const toolsListResponseSchema = z
	.object({
		result: z
			.object({ tools: z.array(z.object({ name: z.string() }).passthrough()) })
			.passthrough(),
	})
	.passthrough();

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

describe("Worker tool routing", () => {
	it("lists the exact bounded three-tool catalog with the public five-minute cache hint", async () => {
		// Given: a valid authenticated modern tools/list request.
		const request = modernMcpRequest("tools/list");

		// When: it reaches the Worker.
		const response = await SELF.fetch(request);

		// Then: the cacheable catalog has the complete v1 tool surface in a fixed order.
		expect(response.status).toBe(200);
		const body = toolsListResponseSchema.parse(await response.json());
		expect(body.result.tools).toHaveLength(3);
		expect(body.result.tools.map((tool: { readonly name: string }) => tool.name)).toEqual([
			"parse_citation",
			"verify_citation",
			"verify_quote",
		]);
		expect(body).toMatchObject({
			result: {
				tools: [
					{
						name: "parse_citation",
						inputSchema: {
							properties: { citation: { maxLength: 256, minLength: 1 } },
							required: ["citation"],
						},
					},
					{
						name: "verify_citation",
						inputSchema: {
							properties: { citation: { maxLength: 256, minLength: 1 } },
							required: ["citation"],
						},
					},
					{
						name: "verify_quote",
						inputSchema: {
							properties: {
								citation: { maxLength: 256, minLength: 1 },
								quote: { maxLength: 10000, minLength: 20 },
							},
							required: ["citation", "quote"],
						},
					},
				],
				ttlMs: 300000,
				cacheScope: "public",
			},
		});
	});

	it("requires an Mcp-Name header that agrees with a tool call body", async () => {
		// Given: a valid tool call whose header identifies a different tool than the JSON-RPC body.
		const request = modernMcpRequest("tools/call", {
			arguments: { citation: "347 U.S. 483" },
			name: "parse_citation",
		});
		request.headers.set("mcp-name", "other_tool");

		// When: the authenticated request enters the SDK handler.
		const response = await SELF.fetch(request);

		// Then: routing metadata inconsistency is rejected before tool execution.
		expect(response.status).toBe(400);
	});

	it("executes a header-complete modern parse tool call without session initialization", async () => {
		// Given: a complete stateless request for the functional parsing tool.
		const request = modernMcpRequest("tools/call", {
			arguments: { citation: "347 U.S. 483" },
			name: "parse_citation",
		});

		// When: the Worker dispatches it after D1-backed authentication.
		const response = await SELF.fetch(request);

		// Then: the official v2 handler returns the versioned structured result directly.
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			id: 1,
			result: {
				structuredContent: {
					citation: { normalized: "347 U.S. 483" },
					contractVersion: "1",
					outcome: "parsed",
				},
			},
		});
	});

	it("returns the contract-v1 indeterminate result for citation verification", async () => {
		// Given: a complete modern request for citation verification.
		const request = modernMcpRequest("tools/call", {
			arguments: { citation: "347 U.S. 483" },
			name: "verify_citation",
		});

		// When: it reaches the current pre-evidence implementation.
		const response = await SELF.fetch(request);

		// Then: it is an explicit operational indeterminate result, not a source claim.
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			id: 1,
			result: {
				isError: true,
				structuredContent: {
					contractVersion: "1",
					outcome: "indeterminate",
					reason: "verification_not_available",
				},
			},
		});
	});

	it("returns the contract-v1 indeterminate result for quote verification", async () => {
		// Given: a complete modern request for quote verification.
		const request = modernMcpRequest("tools/call", {
			arguments: {
				citation: "347 U.S. 483",
				quote: "The Constitution requires equal protection.",
			},
			name: "verify_quote",
		});

		// When: it reaches the current pre-evidence implementation.
		const response = await SELF.fetch(request);

		// Then: it is an explicit operational indeterminate result without echoed quote text.
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			id: 1,
			result: {
				isError: true,
				structuredContent: {
					contractVersion: "1",
					outcome: "indeterminate",
					reason: "verification_not_available",
				},
			},
		});
	});

	it("charges discovery, cache hits, protocol errors, and tool calls exactly once", async () => {
		// Given: a key with four admissions in each rolling window.
		await env.DB.prepare("UPDATE api_key_records SET minute_limit = 4, day_limit = 5").run();

		// When: discovery/cache, an unsupported protocol, and a tool call each reach the Worker.
		const first = await SELF.fetch(modernMcpRequest("tools/list"));
		const cacheHit = await SELF.fetch(modernMcpRequest("tools/list"));
		const unsupported = await SELF.fetch(
			modernMcpRequest("server/discover", { protocolVersion: "2025-06-18" }),
		);
		const tool = await SELF.fetch(
			modernMcpRequest("tools/call", {
				arguments: { citation: "347 U.S. 483" },
				name: "parse_citation",
			}),
		);
		const exhausted = await SELF.fetch(modernMcpRequest("tools/list"));

		// Then: all four authenticated POSTs are charged before their outcomes, and the fifth is denied.
		expect(first.status).toBe(200);
		expect(cacheHit.status).toBe(200);
		expect(unsupported.status).toBe(400);
		expect(tool.status).toBe(200);
		expect(exhausted.status).toBe(429);
		expect(exhausted.headers.get("retry-after")).toBe("60");
	});
});

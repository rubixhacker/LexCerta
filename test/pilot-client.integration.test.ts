import { SELF, env } from "cloudflare:test";
import type { FetchLike } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectPilot, runPilot } from "../examples/pilot-client.js";
import { setupQuoteWorker } from "./fixtures/issue-7-quote-worker.js";

const endpoint = new URL("https://mcp.lexcerta.ai/");
const quote = "Equal justice under law.";
afterEach(() => vi.unstubAllGlobals());

type Frame = {
	readonly method: string;
	readonly version: string | null;
	readonly mcpMethod: string | null;
	readonly mcpName: string | null;
	readonly session: string | null;
	readonly body: Record<string, unknown>;
	readonly status: number;
	readonly result: Record<string, unknown>;
};

function capture(frames: Frame[]): FetchLike {
	return async (input, init) => {
		const request = new Request(input, init);
		const body = await request.clone().json<Record<string, unknown>>();
		const response = await SELF.fetch(request);
		frames.push({
			method: request.method,
			version: request.headers.get("mcp-protocol-version"),
			mcpMethod: request.headers.get("mcp-method"),
			mcpName: request.headers.get("mcp-name"),
			session: request.headers.get("mcp-session-id"),
			body,
			status: response.status,
			result: await response.clone().json<Record<string, unknown>>(),
		});
		return response;
	};
}

function fixtureKey(request: Request): string {
	return (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
}

describe("pinned pilot SDK client through the mounted product", () => {
	it("discovers and executes all three tools with self-contained modern wire requests", async () => {
		const fixture = await setupQuoteWorker({
			opinions: [
				{
					id: 91001,
					body: {
						id: 91001,
						cluster: "https://www.courtlistener.com/api/rest/v4/clusters/108713/",
						plain_text: quote,
					},
				},
			],
		});
		const frames: Frame[] = [];
		const client = await connectPilot(endpoint, fixtureKey(fixture.request()), capture(frames));
		try {
			const result = await runPilot(client, "347 U.S. 483", quote);
			expect(result.discovery).toMatchObject({
				supportedVersions: ["2026-07-28"],
				capabilities: { tools: {} },
			});
			expect(result.tools.tools.map((tool) => tool.name).sort()).toEqual([
				"parse_citation",
				"verify_citation",
				"verify_quote",
			]);
			expect(result.parsed.structuredContent).toMatchObject({ outcome: "parsed" });
			expect(result.citation.structuredContent).toMatchObject({ outcome: "verified" });
			expect(result.quote.structuredContent).toMatchObject({ outcome: "verified" });
		} finally {
			await client.close();
		}
		expect(frames.map((frame) => frame.mcpMethod)).toEqual([
			"server/discover",
			"tools/list",
			"tools/call",
			"tools/call",
			"tools/call",
		]);
		for (const frame of frames) {
			expect(frame.method).toBe("POST");
			expect(frame.session).toBeNull();
			expect(frame.version).toBe("2026-07-28");
			expect(frame.status).toBe(200);
			expect(frame.body).toMatchObject({
				method: frame.mcpMethod,
				params: {
					_meta: {
						"io.modelcontextprotocol/protocolVersion": "2026-07-28",
						"io.modelcontextprotocol/clientCapabilities": {},
					},
				},
			});
			expect(frame.result).toMatchObject({
				result: {
					resultType: expect.any(String),
					_meta: {
						"io.modelcontextprotocol/serverInfo": { name: "lexcerta" },
					},
				},
			});
		}
		expect(
			frames.filter((frame) => frame.mcpMethod === "tools/call").map((frame) => frame.mcpName),
		).toEqual(["parse_citation", "verify_citation", "verify_quote"]);
	});

	it("recreates the client without session resumption or initialization", async () => {
		const fixture = await setupQuoteWorker({ opinions: [] });
		const frames: Frame[] = [];
		for (let instance = 0; instance < 2; instance += 1) {
			const client = await connectPilot(endpoint, fixtureKey(fixture.request()), capture(frames));
			try {
				expect(
					(
						await client.callTool({
							name: "parse_citation",
							arguments: { citation: "347 U.S. 483" },
						})
					).structuredContent,
				).toMatchObject({ outcome: "parsed" });
			} finally {
				await client.close();
			}
		}
		expect(frames.map((frame) => frame.mcpMethod)).toEqual([
			"server/discover",
			"tools/call",
			"server/discover",
			"tools/call",
		]);
		expect(fixture.outbound).toHaveLength(0);
	});

	it("returns citation not-found only when the source completes a negative lookup", async () => {
		const fixture = await setupQuoteWorker({ opinions: [], citationMissing: true });
		const client = await connectPilot(endpoint, fixtureKey(fixture.request()), capture([]));
		try {
			const result = await client.callTool({
				name: "verify_citation",
				arguments: { citation: "347 U.S. 483" },
			});
			expect(result.structuredContent).toMatchObject({ outcome: "not_found" });
			expect(result.isError).not.toBe(true);
		} finally {
			await client.close();
		}
	});

	it("keeps an altered quote negative distinct from unavailable source evidence", async () => {
		const fixture = await setupQuoteWorker({ opinions: [{ id: 91001 }] });
		const client = await connectPilot(endpoint, fixtureKey(fixture.request()), capture([]));
		try {
			const result = await client.callTool({
				name: "verify_quote",
				arguments: { citation: "347 U.S. 483", quote },
			});
			expect(result.structuredContent).toMatchObject({ outcome: "not_found" });
		} finally {
			await client.close();
		}
		const unavailable = await setupQuoteWorker({ opinions: [{ id: 91001, status: 503 }] });
		const another = await connectPilot(endpoint, fixtureKey(unavailable.request()), capture([]));
		try {
			const result = await another.callTool({
				name: "verify_quote",
				arguments: { citation: "347 U.S. 483", quote },
			});
			expect(result).toMatchObject({
				isError: true,
				structuredContent: { outcome: "indeterminate" },
			});
		} finally {
			await another.close();
		}
	});

	it.each(["revoked", "expired"])("surfaces %s credentials as transport failure", async (state) => {
		const fixture = await setupQuoteWorker({ opinions: [] });
		await env.DB.prepare(
			state === "revoked"
				? "UPDATE api_key_records SET status = 'revoked', revoked_at = '2020-01-01T00:00:00.000Z'"
				: "UPDATE api_key_records SET expires_at = '2020-01-01T00:00:00.000Z'",
		).run();
		const frames: Frame[] = [];
		await expect(
			connectPilot(endpoint, fixtureKey(fixture.request()), capture(frames)),
		).rejects.toThrow();
		expect(frames.map((frame) => frame.status)).toEqual([401]);
		expect(fixture.outbound).toHaveLength(0);
	});

	it("surfaces allowance exhaustion without retry or legacy fallback", async () => {
		const fixture = await setupQuoteWorker({ opinions: [] });
		await env.DB.prepare("UPDATE api_key_records SET minute_limit = 2, day_limit = 2").run();
		const frames: Frame[] = [];
		const client = await connectPilot(endpoint, fixtureKey(fixture.request()), capture(frames));
		try {
			await client.listTools();
			await expect(
				client.callTool({ name: "parse_citation", arguments: { citation: "347 U.S. 483" } }),
			).rejects.toMatchObject({ data: { status: 429 } });
		} finally {
			await client.close();
		}
		expect(frames.map((frame) => frame.status)).toEqual([200, 200, 429]);
		expect(fixture.outbound).toHaveLength(0);
	});

	it("fails explicitly against a legacy-only server", async () => {
		const methods: string[] = [];
		await expect(
			connectPilot(new URL("http://127.0.0.1:3001/"), "local-fixture-only", async (input, init) => {
				const request = new Request(input, init);
				const body = await request.json<{ id: number; method: string }>();
				methods.push(body.method);
				return Response.json(
					{
						jsonrpc: "2.0",
						id: body.id,
						error: { code: -32601, message: "Legacy fixture requires initialize" },
					},
					{ status: 404 },
				);
			}),
		).rejects.toThrow();
		expect(methods).toEqual(["server/discover"]);
	});
});

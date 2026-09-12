import { SELF, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker.js";
import { setupQuoteWorker } from "./fixtures/issue-7-quote-worker.js";

const versionKey = "io.modelcontextprotocol/protocolVersion";
const capabilitiesKey = "io.modelcontextprotocol/clientCapabilities";
afterEach(() => vi.unstubAllGlobals());

type WireRequest = { id?: unknown; method?: unknown; params?: unknown };

async function rewriteBody(request: Request, change: (body: WireRequest) => void) {
	const body = await request.json<WireRequest>();
	change(body);
	return new Request(request.url, {
		method: "POST",
		headers: request.headers,
		body: JSON.stringify(body),
	});
}

describe("mounted stateless MCP boundary", () => {
	it("rejects even an empty supplied Origin at the application boundary", async () => {
		const fixture = await setupQuoteWorker({ opinions: [] });
		const request = fixture.request();
		request.headers.set("origin", "");
		// workerd's HTTP bridge removes empty headers; exercise the application with it intact.
		expect(request.headers.has("origin")).toBe(true);
		expect(
			(await worker.fetch(request, { ...env, API_KEY_PEPPER: "local-test-pepper" })).status,
		).toBe(403);
		expect(fixture.outbound).toHaveLength(0);
	});

	it.each(["tools/list", "tools/call"])(
		"accepts %s as the first request on fresh handler instances",
		async (method) => {
			const fixture = await setupQuoteWorker({ opinions: [] });
			for (let instance = 0; instance < 2; instance += 1) {
				const request = await rewriteBody(fixture.request(), (body) => {
					body.method = method;
					body.params = {
						_meta: { [versionKey]: "2026-07-28", [capabilitiesKey]: {} },
						...(method === "tools/call"
							? { name: "parse_citation", arguments: { citation: "347 U.S. 483" } }
							: {}),
					};
				});
				request.headers.set("mcp-method", method);
				if (method === "tools/call") request.headers.set("mcp-name", "parse_citation");
				else request.headers.delete("mcp-name");
				const response = await SELF.fetch(request);
				expect(response.status).toBe(200);
				expect(response.headers.has("mcp-session-id")).toBe(false);
				expect(await response.json()).toMatchObject({ result: { resultType: "complete" } });
			}
			expect(fixture.outbound).toHaveLength(0);
		},
	);
	it.each([
		["mcp-protocol-version", null],
		["mcp-protocol-version", "2026-01-01"],
		["mcp-method", null],
		["mcp-method", "tools/list"],
		["mcp-name", null],
		["mcp-name", "parse_citation"],
	])("preserves the header error for %s=%s before source work", async (header, value) => {
		const fixture = await setupQuoteWorker({ opinions: [] });
		const request = fixture.request();
		if (value === null) request.headers.delete(header);
		else request.headers.set(header, value);
		const response = await SELF.fetch(request);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ jsonrpc: "2.0", id: 1, error: { code: -32020 } });
		expect(fixture.outbound).toHaveLength(0);
	});

	it.each([versionKey, capabilitiesKey])("rejects missing required metadata %s", async (key) => {
		const fixture = await setupQuoteWorker({ opinions: [] });
		const request = await rewriteBody(fixture.request(), (body) => {
			body.params = {
				name: "verify_quote",
				arguments: { citation: "347 U.S. 483", quote: "test" },
				_meta: key === versionKey ? { [capabilitiesKey]: {} } : { [versionKey]: "2026-07-28" },
			};
		});
		const response = await SELF.fetch(request);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ id: 1, error: { code: -32602 } });
		expect(fixture.outbound).toHaveLength(0);
	});

	it("returns method-not-found for an unknown method", async () => {
		const fixture = await setupQuoteWorker({ opinions: [] });
		const request = await rewriteBody(fixture.request(), (body) => {
			body.method = "unknown/method";
		});
		request.headers.set("mcp-method", "unknown/method");
		request.headers.delete("mcp-name");
		const response = await SELF.fetch(request);
		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({ id: 1, error: { code: -32601 } });
		expect(fixture.outbound).toHaveLength(0);
	});

	it.each(["https://attacker.example", "https://mcp.lexcerta.ai", "null"])(
		"rejects supplied Origin %s without charging or fetching",
		async (origin) => {
			const fixture = await setupQuoteWorker({ opinions: [] });
			await env.DB.prepare("UPDATE api_key_records SET minute_limit = 1, day_limit = 1").run();
			const hostile = fixture.request();
			hostile.headers.set("origin", origin);
			const rejected = await SELF.fetch(hostile);
			expect(rejected.status).toBe(403);
			expect(rejected.headers.get("cache-control")).toBe("no-store");
			expect(fixture.outbound).toHaveLength(0);
			const allowed = await rewriteBody(fixture.request(), (body) => {
				body.params = {
					name: "parse_citation",
					arguments: { citation: "347 U.S. 483" },
					_meta: { [versionKey]: "2026-07-28", [capabilitiesKey]: {} },
				};
			});
			allowed.headers.set("mcp-name", "parse_citation");
			expect((await SELF.fetch(allowed)).status).toBe(200);
			expect(fixture.outbound).toHaveLength(0);
		},
	);

	it.each(["quota-id", 42])("correlates quota exhaustion to bounded ID %s", async (id) => {
		const fixture = await setupQuoteWorker({ opinions: [] });
		await env.DB.prepare("UPDATE api_key_records SET minute_limit = 1, day_limit = 1").run();
		const prime = await rewriteBody(fixture.request(), (body) => {
			body.method = "tools/list";
		});
		prime.headers.set("mcp-method", "tools/list");
		prime.headers.delete("mcp-name");
		expect((await SELF.fetch(prime)).status).toBe(200);
		const exhausted = await rewriteBody(fixture.request("PRIVATE_QUOTE_SENTINEL"), (body) => {
			body.id = id;
		});
		const response = await SELF.fetch(exhausted);
		expect(response.status).toBe(429);
		expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.json()).toEqual({
			jsonrpc: "2.0",
			id,
			error: { code: 1001, message: "API key allowance exhausted" },
		});
		expect(fixture.outbound).toHaveLength(0);
	});
});

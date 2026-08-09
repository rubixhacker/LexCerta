import { SELF, createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import {
	CLIENT_CAPABILITIES_META_KEY,
	CLIENT_INFO_META_KEY,
	PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/worker.js";
import { createLocalAuthFixture } from "./fixtures/api-key.js";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Worker telemetry", () => {
	it("emits redacted structured logs and identifier-free Analytics Engine metrics", async () => {
		// Given: a real workerd request with legal-content and credential canaries.
		const fixture = await createLocalAuthFixture({ publicId: `telemetry-${crypto.randomUUID()}` });
		await installApiKey(fixture.record);
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const write = vi.spyOn(env.TELEMETRY, "writeDataPoint");
		const context = createExecutionContext();
		const request = parseCitationRequest(fixture.token, "347 U.S. 483 QUOTE_CANARY");

		// When: the actual Worker completes and its waitUntil telemetry settles.
		const response = await worker.fetch(
			request,
			{ ...env, API_KEY_PEPPER: "local-test-pepper" },
			context,
		);
		await waitOnExecutionContext(context);

		// Then: telemetry contains only approved dimensions and no Customer-supplied canary.
		expect(response.status).toBe(200);
		expect(log).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "mcp.request.completed",
				keyIdentifier: null,
				outcome: "parsed",
				tool: "parse_citation",
			}),
		);
		expect(write).toHaveBeenCalledWith(
			expect.objectContaining({
				blobs: [
					"parse_citation",
					"parsed",
					"not_used",
					"not_applicable",
					"not_called",
					"not_called",
					"none",
				],
			}),
		);
		expect(JSON.stringify(log.mock.calls)).not.toContain("QUOTE_CANARY");
		expect(JSON.stringify(write.mock.calls)).not.toContain("QUOTE_CANARY");
		expect(JSON.stringify(write.mock.calls)).not.toContain(fixture.token);
	});

	it("keeps the public SELF fetch result unchanged while telemetry is enabled", async () => {
		// Given: an authorized request that travels through the public workerd service binding.
		const fixture = await createLocalAuthFixture({
			publicId: `telemetry-self-${crypto.randomUUID()}`,
		});
		await installApiKey(fixture.record);

		// When: the service binding sends the request to the deployed Worker surface.
		const response = await SELF.fetch(parseCitationRequest(fixture.token, "347 U.S. 483"));

		// Then: best-effort telemetry does not alter the successful MCP result.
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			result: { structuredContent: { outcome: "parsed" } },
		});
	});

	it("records an authentication infrastructure failure distinctly from admission unavailability", async () => {
		// Given: a Worker environment where key verification is unavailable before MCP parsing.
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const unavailableAuthenticationEnvironment = { ...env, API_KEY_PEPPER: "" } satisfies Env;
		const context = createExecutionContext();
		const request = new Request("https://mcp.lexcerta.ai/", {
			method: "POST",
			headers: { authorization: `Bearer lc_test_authorization-canary_${"A".repeat(43)}` },
		});

		// When: the direct workerd Worker rejects it before reading any MCP payload.
		const response = await worker.fetch(request, unavailableAuthenticationEnvironment, context);
		await waitOnExecutionContext(context);

		// Then: telemetry records the auth-boundary outcome without the authorization canary.
		expect(response.status).toBe(503);
		expect(log).toHaveBeenCalledWith(
			expect.objectContaining({
				errorCategory: "authentication",
				outcome: "authentication_unavailable",
			}),
		);
		expect(JSON.stringify(log.mock.calls)).not.toContain("authorization-canary");
	});

	it("records an authentication denial through the direct workerd Worker", async () => {
		// Given: a validly shaped credential that has no matching active API key record.
		const fixture = await createLocalAuthFixture({
			publicId: `telemetry-401-${crypto.randomUUID()}`,
		});
		await installApiKey(fixture.record);
		const context = createExecutionContext();
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const deniedToken = `lc_test_${fixture.record.public_id}_${"B".repeat(43)}`;

		// When: the direct Worker rejects the credential before admission or MCP parsing.
		const response = await worker.fetch(
			new Request("https://mcp.lexcerta.ai/", {
				method: "POST",
				headers: { authorization: `Bearer ${deniedToken}` },
			}),
			{ ...env, API_KEY_PEPPER: fixture.pepper },
			context,
		);
		await waitOnExecutionContext(context);

		// Then: telemetry distinguishes a denial and retains none of the credential.
		expect(response.status).toBe(401);
		expect(log).toHaveBeenCalledWith(
			expect.objectContaining({ errorCategory: "authentication", outcome: "unauthorized" }),
		);
		expect(JSON.stringify(log.mock.calls)).not.toContain(deniedToken);
	});

	it("records a bodyless payload rejection through the direct workerd Worker", async () => {
		// Given: an admitted authenticated request whose body exceeds the MCP boundary.
		const fixture = await createLocalAuthFixture({
			publicId: `telemetry-413-${crypto.randomUUID()}`,
		});
		await installApiKey(fixture.record);
		const context = createExecutionContext();
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const request = new Request("https://mcp.lexcerta.ai/", {
			method: "POST",
			headers: {
				authorization: `Bearer ${fixture.token}`,
				"mcp-protocol-version": "2026-07-28",
			},
			body: "x".repeat(65_537),
		});

		// When: the real Worker rejects the oversize body before MCP parsing.
		const response = await worker.fetch(
			request,
			admittedEnvironment(fixture.pepper, "allowed"),
			context,
		);
		await waitOnExecutionContext(context);

		// Then: the bodyless 413 produces a payload event without content exposure.
		expect(response.status).toBe(413);
		expect(response.body).toBeNull();
		expect(log).toHaveBeenCalledWith(
			expect.objectContaining({ errorCategory: "payload", outcome: "payload_too_large" }),
		);
	});

	it("records a bodyless admission exhaustion through the direct workerd Worker", async () => {
		// Given: an authenticated request whose limiter reports the Customer allowance exhausted.
		const fixture = await createLocalAuthFixture({
			publicId: `telemetry-429-${crypto.randomUUID()}`,
		});
		await installApiKey(fixture.record);
		const context = createExecutionContext();
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const request = new Request("https://mcp.lexcerta.ai/", {
			method: "POST",
			headers: { authorization: `Bearer ${fixture.token}` },
		});

		// When: the direct Worker receives an exhausted admission before it reads an RPC request ID.
		const response = await worker.fetch(
			request,
			admittedEnvironment(fixture.pepper, "exhausted"),
			context,
		);
		await waitOnExecutionContext(context);

		// Then: the bodyless 429 records admission exhaustion without a parse failure.
		expect(response.status).toBe(429);
		expect(response.body).toBeNull();
		expect(log).toHaveBeenCalledWith(
			expect.objectContaining({ errorCategory: "admission", outcome: "admission_exhausted" }),
		);
	});

	it("keeps the completed response when Analytics Engine rejects a metric", async () => {
		// Given: an authenticated workerd request and a telemetry dataset that fails at write time.
		const fixture = await createLocalAuthFixture({
			publicId: `telemetry-write-${crypto.randomUUID()}`,
		});
		await installApiKey(fixture.record);
		const context = createExecutionContext();
		vi.spyOn(env.TELEMETRY, "writeDataPoint").mockImplementation(() => {
			throw new Error("ANALYTICS_FAILURE_CANARY");
		});

		// When: the Worker completes a public request and its best-effort telemetry runs.
		const workerEnvironment = { ...env, API_KEY_PEPPER: fixture.pepper } satisfies Env;
		const response = await worker.fetch(
			parseCitationRequest(fixture.token, "347 U.S. 483"),
			workerEnvironment,
			context,
		);
		await waitOnExecutionContext(context);

		// Then: telemetry failure neither changes the response nor reports its error content.
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			result: { structuredContent: { outcome: "parsed" } },
		});
	});
});

function admittedEnvironment(pepper: string, decision: "allowed" | "exhausted"): Env {
	return {
		...env,
		API_KEY_PEPPER: pepper,
		API_KEY_LIMITER: {
			getByName: () => ({
				admit: async () =>
					decision === "allowed"
						? ({ kind: "allowed" } as const)
						: { kind: "exhausted", retryAfterSeconds: 1 },
			}),
		},
	};
}

async function installApiKey(record: {
	readonly day_limit: number;
	readonly environment: string;
	readonly expires_at: string;
	readonly hmac_sha256_hex: string;
	readonly limits_version: number;
	readonly minute_limit: number;
	readonly public_id: string;
	readonly revoked_at: string | null;
	readonly status: string;
}): Promise<void> {
	await env.DB.prepare("DROP TABLE IF EXISTS api_key_records").run();
	await env.DB.prepare(
		"CREATE TABLE api_key_records (public_id TEXT PRIMARY KEY NOT NULL, environment TEXT NOT NULL, hmac_sha256_hex TEXT NOT NULL, status TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT, minute_limit INTEGER NOT NULL DEFAULT 60, day_limit INTEGER NOT NULL DEFAULT 1000, limits_version INTEGER NOT NULL DEFAULT 1)",
	).run();
	await env.DB.prepare(
		"INSERT INTO api_key_records (public_id, environment, hmac_sha256_hex, status, expires_at, revoked_at, minute_limit, day_limit, limits_version) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
	)
		.bind(
			record.public_id,
			record.environment,
			record.hmac_sha256_hex,
			record.status,
			record.expires_at,
			record.revoked_at,
			record.minute_limit,
			record.day_limit,
			record.limits_version,
		)
		.run();
}

function parseCitationRequest(token: string, citation: string): Request {
	return new Request("https://mcp.lexcerta.ai/", {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
			"mcp-method": "tools/call",
			"mcp-name": "parse_citation",
			"mcp-protocol-version": "2026-07-28",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "parse_citation",
				arguments: { citation },
				_meta: {
					[PROTOCOL_VERSION_META_KEY]: "2026-07-28",
					[CLIENT_INFO_META_KEY]: { name: "issue-9-workerd", version: "1.0.0" },
					[CLIENT_CAPABILITIES_META_KEY]: {},
				},
			},
		}),
	});
}

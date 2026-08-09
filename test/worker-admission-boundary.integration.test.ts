import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker, { type Env } from "../src/worker.js";
import { createLocalAuthFixture } from "./fixtures/api-key.js";

type AdmissionStub = {
	readonly admit: (input: {
		readonly admittedAt: number;
		readonly limits: { readonly minute: number; readonly day: number };
	}) => Promise<
		| { readonly kind: "allowed" }
		| { readonly kind: "exhausted"; readonly retryAfterSeconds: number }
	>;
};

type AdmissionNamespace = {
	readonly getByName: (name: string) => AdmissionStub;
};

let request: Request;
let workerEnvironment: Env;

beforeEach(async () => {
	const fixture = await createLocalAuthFixture({ publicId: `boundary-${crypto.randomUUID()}` });
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
	request = new Request("https://mcp.lexcerta.ai/", {
		method: "POST",
		headers: {
			authorization: `Bearer ${fixture.token}`,
			"content-type": "application/json",
			"mcp-method": "server/discover",
			"mcp-protocol-version": "2026-07-28",
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "server/discover" }),
	});
	workerEnvironment = {
		API_KEY_LIMITER: { getByName: () => ({ admit: async () => ({ kind: "allowed" }) }) },
		API_KEY_PEPPER: fixture.pepper,
		BUILD_ID: "local",
		DB: env.DB,
		KEY_ENVIRONMENT: "test",
	};
});

describe("Worker admission adapter boundaries", () => {
	it("fails closed for a non-Error limiter rejection", async () => {
		// Given: an authenticated request and a limiter binding that rejects with a non-Error value.
		workerEnvironment = {
			...workerEnvironment,
			API_KEY_LIMITER: {
				getByName: () => ({ admit: async () => Promise.reject("limiter unavailable") }),
			},
		};

		// When: the request reaches the Worker admission boundary.
		const response = await worker.fetch(request, workerEnvironment);

		// Then: the Worker returns retryable 503 without dispatching MCP.
		expect(response.status).toBe(503);
		expect(response.headers.get("retry-after")).toBe("1");
		expect(await response.text()).toBe('{"error":"Service Unavailable"}');
	});

	it("returns an ID-unrecoverable 429 when request cloning fails", async () => {
		// Given: an exhausted limiter and a request whose body clone unexpectedly throws.
		workerEnvironment = {
			...workerEnvironment,
			API_KEY_LIMITER: {
				getByName: () => ({ admit: async () => ({ kind: "exhausted", retryAfterSeconds: 12 }) }),
			},
		};
		Object.defineProperty(request, "clone", {
			value: () => {
				throw new RangeError("clone failed");
			},
		});

		// When: exhaustion response construction attempts to recover the JSON-RPC ID.
		const response = await worker.fetch(request, workerEnvironment);

		// Then: exhaustion remains HTTP 429 with backoff and no fabricated JSON-RPC ID.
		expect(response.status).toBe(429);
		expect(response.headers.get("retry-after")).toBe("12");
		expect(await response.text()).toBe("");
	});
});

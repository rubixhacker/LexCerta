import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker, { type Env } from "../src/worker.js";
import { createLocalAuthFixture } from "./fixtures/api-key.js";

type AdmissionStub = {
	readonly admit: (input: {
		readonly admittedAt: number;
		readonly limits: { readonly minute: number; readonly day: number };
		readonly limitsVersion: number;
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
		API_KEY_LIMITER: {
			getByName: () => ({ admit: async () => ({ kind: "allowed" }) }),
		},
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

	it("fails closed for a same-version limit conflict", async () => {
		// Given: an authenticated request and a limiter that rejects a conflicting versioned limit.
		workerEnvironment = {
			...workerEnvironment,
			API_KEY_LIMITER: {
				getByName: () => ({ admit: async () => Promise.reject(new Error("limits conflict")) }),
			},
		};

		// When: the request reaches the versioned admission boundary.
		const response = await worker.fetch(request, workerEnvironment);

		// Then: the conflict fails closed as retryable unavailability without MCP dispatch.
		expect(response.status).toBe(503);
		expect(response.headers.get("retry-after")).toBe("1");
		expect(await response.text()).toBe('{"error":"Service Unavailable"}');
	});

	it("returns an ID-unrecoverable 429 when request body access fails", async () => {
		// Given: an exhausted limiter and a request whose body access unexpectedly throws.
		workerEnvironment = {
			...workerEnvironment,
			API_KEY_LIMITER: {
				getByName: () => ({ admit: async () => ({ kind: "exhausted", retryAfterSeconds: 12 }) }),
			},
		};
		Object.defineProperty(request, "body", {
			get: () => {
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

	it("bounds streamed request-ID recovery without a Content-Length header", async () => {
		// Given: an exhausted limiter and a chunked body larger than the recovery cap.
		workerEnvironment = {
			...workerEnvironment,
			API_KEY_LIMITER: {
				getByName: () => ({ admit: async () => ({ kind: "exhausted", retryAfterSeconds: 9 }) }),
			},
		};
		const payload = new TextEncoder().encode(`{"jsonrpc":"2.0","id":"${"x".repeat(20_000)}"}`);
		const authorization = request.headers.get("authorization") ?? "";
		request = new Request("https://mcp.lexcerta.ai/", {
			method: "POST",
			headers: {
				authorization,
				"content-type": "application/json",
				"mcp-method": "server/discover",
				"mcp-protocol-version": "2026-07-28",
			},
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(payload);
					controller.close();
				},
			}),
		});

		// When: the Worker attempts to recover an ID from the oversized stream.
		const response = await worker.fetch(request, workerEnvironment);

		// Then: it stops at the cap and never reflects the oversized request ID.
		expect(request.headers.has("content-length")).toBe(false);
		expect(response.status).toBe(429);
		expect(response.headers.get("retry-after")).toBe("9");
		expect(await response.text()).toBe("");
	});

	it("cancels a never-closing oversized stream promptly", async () => {
		// Given: an exhausted limiter and a stream that emits over the cap but never closes.
		workerEnvironment = {
			...workerEnvironment,
			API_KEY_LIMITER: {
				getByName: () => ({ admit: async () => ({ kind: "exhausted", retryAfterSeconds: 10 }) }),
			},
		};
		let canceled = false;
		const payload = new TextEncoder().encode(`{"jsonrpc":"2.0","id":"${"x".repeat(20_000)}"}`);
		const authorization = request.headers.get("authorization") ?? "";
		request = new Request("https://mcp.lexcerta.ai/", {
			method: "POST",
			headers: {
				authorization,
				"content-type": "application/json",
				"mcp-method": "server/discover",
				"mcp-protocol-version": "2026-07-28",
			},
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(payload);
				},
				cancel() {
					canceled = true;
				},
			}),
		});

		// When: the Worker recovers an ID from the stream with a one-second test bound.
		const response = await worker.fetch(request, workerEnvironment);

		// Then: direct cancellation completes promptly and the response does not reflect the oversized ID.
		expect(canceled).toBe(true);
		expect(response.status).toBe(429);
		expect(await response.text()).toBe("");
	}, 1_000);

	it("does not reflect an oversized string request ID", async () => {
		// Given: an exhausted limiter and a valid JSON envelope with a 257-character string ID.
		workerEnvironment = {
			...workerEnvironment,
			API_KEY_LIMITER: {
				getByName: () => ({ admit: async () => ({ kind: "exhausted", retryAfterSeconds: 8 }) }),
			},
		};
		const headers = new Headers(request.headers);
		request = new Request("https://mcp.lexcerta.ai/", {
			method: "POST",
			headers,
			body: JSON.stringify({ jsonrpc: "2.0", id: "x".repeat(257), method: "server/discover" }),
		});

		// When: the Worker evaluates the exhausted response's recoverable ID.
		const response = await worker.fetch(request, workerEnvironment);

		// Then: the response stays bodyless rather than reflecting an oversized identifier.
		expect(response.status).toBe(429);
		expect(await response.text()).toBe("");
	});

	it.each(["1e400", "9007199254740993"])(
		"does not reflect an unsafe numeric request ID (%s)",
		async (numericId) => {
			// Given: an exhausted limiter and a JSON-RPC envelope with an unsafe numeric ID.
			workerEnvironment = {
				...workerEnvironment,
				API_KEY_LIMITER: {
					getByName: () => ({
						admit: async () => ({ kind: "exhausted", retryAfterSeconds: 7 }),
					}),
				},
			};
			const headers = new Headers(request.headers);
			request = new Request("https://mcp.lexcerta.ai/", {
				method: "POST",
				headers,
				body: `{"jsonrpc":"2.0","id":${numericId},"method":"server/discover"}`,
			});

			// When: the Worker evaluates the exhausted response's numeric request ID.
			const response = await worker.fetch(request, workerEnvironment);

			// Then: unsafe numeric values remain bodyless rather than being rounded or serialized as null.
			expect(response.status).toBe(429);
			expect(await response.text()).toBe("");
		},
	);

	it("echoes a finite fractional numeric request ID", async () => {
		// Given: an exhausted limiter and a JSON-RPC envelope with a finite fractional ID.
		workerEnvironment = {
			...workerEnvironment,
			API_KEY_LIMITER: {
				getByName: () => ({ admit: async () => ({ kind: "exhausted", retryAfterSeconds: 6 }) }),
			},
		};
		const headers = new Headers(request.headers);
		request = new Request("https://mcp.lexcerta.ai/", {
			method: "POST",
			headers,
			body: '{"jsonrpc":"2.0","id":1.5,"method":"server/discover"}',
		});

		// When: the Worker evaluates the exhausted response's fractional numeric request ID.
		const response = await worker.fetch(request, workerEnvironment);

		// Then: the finite bounded number is recoverable and echoed in the JSON-RPC error.
		expect(response.status).toBe(429);
		expect(await response.json()).toEqual({
			jsonrpc: "2.0",
			id: 1.5,
			error: { code: -32029, message: "API key allowance exhausted" },
		});
	});
});

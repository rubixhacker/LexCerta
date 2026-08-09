import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker, { type Env } from "../src/worker.js";
import { createLocalAuthFixture } from "./fixtures/api-key.js";

type AdmissionStub = {
	readonly admit: (input: { readonly admittedAt: number; readonly publicId: string }) => Promise<
		| { readonly kind: "allowed" }
		| { readonly kind: "exhausted"; readonly retryAfterSeconds: number }
	>;
};

let request: Request;
let workerEnvironment: Env;

beforeEach(async () => {
	const fixture = await createLocalAuthFixture({ publicId: `recovery-${crypto.randomUUID()}` });
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
			getByName: (): AdmissionStub => ({ admit: async () => ({ kind: "allowed" }) }),
		},
		API_KEY_PEPPER: fixture.pepper,
		BUILD_ID: "local",
		DB: env.DB,
		KEY_ENVIRONMENT: "test",
	};
});

describe("Worker admission stream recovery", () => {
	it("bounds streamed request-ID recovery without a Content-Length header", async () => {
		// Given: an exhausted limiter and a chunked body larger than the recovery cap.
		workerEnvironment = exhaustedEnvironment(workerEnvironment, 9);
		const payload = new TextEncoder().encode(`{"jsonrpc":"2.0","id":"${"x".repeat(20_000)}"}`);
		request = streamedRequest(request, payload, true);

		// When: the Worker attempts to recover an ID from the oversized stream.
		const response = await worker.fetch(request, workerEnvironment);

		// Then: it stops at the cap and never reflects the oversized request ID.
		expect(request.headers.has("content-length")).toBe(false);
		expect(response.status).toBe(429);
		expect(response.headers.get("retry-after")).toBe("9");
		expect(await response.text()).toBe("");
	});

	it("cancels a never-closing stream promptly", async () => {
		// Given: an exhausted limiter and a stream that emits below the cap but never closes.
		workerEnvironment = exhaustedEnvironment(workerEnvironment, 10);
		let canceled = false;
		request = streamedRequest(
			request,
			new TextEncoder().encode('{"jsonrpc":"2.0","id":"pending"}'),
			false,
			() => {
				canceled = true;
			},
		);

		// When: the Worker recovers an ID from the stream with a one-second test bound.
		const response = await worker.fetch(request, workerEnvironment);

		// Then: direct cancellation completes promptly and the response does not reflect the pending ID.
		expect(canceled).toBe(true);
		expect(response.status).toBe(429);
		expect(await response.text()).toBe("");
	}, 1_000);

	it("cancels an endless empty-chunk stream promptly", async () => {
		// Given: an exhausted limiter and a stream that never closes while emitting empty chunks.
		workerEnvironment = exhaustedEnvironment(workerEnvironment, 11);
		let canceled = false;
		request = streamedRequest(
			request,
			undefined,
			false,
			() => {
				canceled = true;
			},
			256,
		);

		// When: the Worker recovers an ID from the endless empty chunks.
		const response = await worker.fetch(request, workerEnvironment);

		// Then: the chunk cap cancels the stream and returns a bodyless denial promptly.
		expect(canceled).toBe(true);
		expect(response.status).toBe(429);
		expect(await response.text()).toBe("");
	}, 1_000);
});

function exhaustedEnvironment(environment: Env, retryAfterSeconds: number): Env {
	return {
		...environment,
		API_KEY_LIMITER: {
			getByName: () => ({ admit: async () => ({ kind: "exhausted", retryAfterSeconds }) }),
		},
	};
}

function streamedRequest(
	base: Request,
	payload: Uint8Array | undefined,
	close: boolean,
	onCancel?: () => void,
	emptyChunks = 0,
): Request {
	const authorization = base.headers.get("authorization") ?? "";
	return new Request("https://mcp.lexcerta.ai/", {
		method: "POST",
		headers: {
			authorization,
			"content-type": "application/json",
			"mcp-method": "server/discover",
			"mcp-protocol-version": "2026-07-28",
		},
		body: new ReadableStream<Uint8Array>({
			start(controller) {
				if (payload !== undefined) controller.enqueue(payload);
				for (let index = 0; index < emptyChunks; index += 1) controller.enqueue(new Uint8Array());
				if (close) controller.close();
			},
			...(onCancel === undefined ? {} : { cancel: onCancel }),
		}),
	});
}

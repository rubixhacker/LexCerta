import { SELF, env, runInDurableObject } from "cloudflare:test";
import {
	CLIENT_CAPABILITIES_META_KEY,
	CLIENT_INFO_META_KEY,
	PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { initialCourtListenerBudgetState } from "../src/courtlistener/budget.js";
import { createLocalAuthFixture } from "./fixtures/api-key.js";

type Deferred<Value> = {
	readonly promise: Promise<Value>;
	readonly resolve: (value: Value) => void;
};
type RetryHeader = string | null;

let authorization = "";
let citationRetryAfter: RetryHeader | undefined;
let usageRetryAfter: RetryHeader | undefined;
let usageCalls = 0;
let holdUsageCall: number | undefined;
let usageArrival: Deferred<void> | undefined;
let usageRelease: Deferred<void> | undefined;
const outbound: Request[] = [];

beforeEach(async () => {
	const fixture = await createLocalAuthFixture({ publicId: `reservation-${crypto.randomUUID()}` });
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
	citationRetryAfter = undefined;
	usageRetryAfter = undefined;
	usageCalls = 0;
	holdUsageCall = undefined;
	usageArrival = undefined;
	usageRelease = undefined;
	outbound.length = 0;
	const coordinator = env.COURTLISTENER_COORDINATOR.getByName(env.COURTLISTENER_CREDENTIAL_ID);
	await runInDurableObject(coordinator, (_instance, state) => {
		state.storage.sql.exec(
			"UPDATE courtlistener_budget_state SET state_json = ?1 WHERE singleton = 1",
			JSON.stringify(initialCourtListenerBudgetState()),
		);
	});
	vi.stubGlobal("fetch", fixtureFetch);
});

afterEach(() => vi.unstubAllGlobals());

function deferred<Value>(): Deferred<Value> {
	let resolve: ((value: Value) => void) | undefined;
	const promise = new Promise<Value>((resolvePromise) => {
		resolve = resolvePromise;
	});
	if (resolve === undefined) throw new Error("Deferred resolver was not initialized.");
	return { promise, resolve };
}

function fixtureFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	const request = input instanceof Request ? input : new Request(input, init);
	outbound.push(request);
	if (request.method === "POST") return Promise.resolve(rateResponse(citationRetryAfter));
	usageCalls += 1;
	if (usageRetryAfter !== undefined) return Promise.resolve(rateResponse(usageRetryAfter));
	if (usageCalls === holdUsageCall) {
		if (usageArrival === undefined || usageRelease === undefined) {
			throw new Error("Usage barrier was not configured.");
		}
		usageArrival.resolve();
		return usageRelease.promise.then(() => usageResponse());
	}
	return Promise.resolve(usageResponse());
}

function rateResponse(retryAfter: RetryHeader | undefined): Response {
	if (retryAfter === undefined) return citationResponse();
	return new Response(null, {
		headers: retryAfter === null ? {} : { "retry-after": retryAfter },
		status: 429,
	});
}

function citationResponse(): Response {
	return Response.json([
		{
			status: 200,
			normalized_citations: ["347 U.S. 483"],
			clusters: [{ id: 108713, absolute_url: "/opinion/108713/brown-v-board-of-education/" }],
		},
	]);
}

function usageResponse(): Response {
	return Response.json({
		current_usage: ["user", "citations", "api_usage"].map((scope) => ({
			scope,
			rate: "minute",
			used: 0,
			limit: 5,
			remaining: 5,
			window_seconds: 60,
			reset_at: "2026-08-09T12:01:00.000Z",
			blocked: false,
		})),
	});
}

function citationRequest(): Request {
	const protocolVersion = "2026-07-28";
	return new Request("https://mcp.lexcerta.ai/", {
		method: "POST",
		headers: {
			authorization,
			"content-type": "application/json",
			"mcp-method": "tools/call",
			"mcp-name": "verify_citation",
			"mcp-protocol-version": protocolVersion,
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "verify_citation",
				arguments: { citation: "347 U.S. 483" },
				_meta: {
					[PROTOCOL_VERSION_META_KEY]: protocolVersion,
					[CLIENT_INFO_META_KEY]: { name: "workerd-integration", version: "1.0.0" },
					[CLIENT_CAPABILITIES_META_KEY]: {},
				},
			},
		}),
	});
}

const pendingSyncSchema = z
	.object({
		pendingReservations: z.array(
			z.object({ kind: z.literal("quota_sync"), token: z.string().min(1) }),
		),
		quota: z.object({ kind: z.literal("sync_in_progress"), token: z.string().min(1) }),
	})
	.passthrough();

async function storedState(): Promise<unknown> {
	const coordinator = env.COURTLISTENER_COORDINATOR.getByName(env.COURTLISTENER_CREDENTIAL_ID);
	const encoded = await runInDurableObject(coordinator, (_instance, state) => {
		const row = state.storage.sql
			.exec<{ readonly state_json: string }>(
				"SELECT state_json FROM courtlistener_budget_state WHERE singleton = 1",
			)
			.toArray()[0];
		if (row === undefined) throw new Error("CourtListener coordinator state is missing.");
		return row.state_json;
	});
	return JSON.parse(encoded);
}

describe("Worker citation quota reservations", () => {
	it("holds the initial usage request behind exactly one correlated quota-sync reservation", async () => {
		// Given: a paused first usage response before any CourtListener data request.
		holdUsageCall = 1;
		usageArrival = deferred<void>();
		usageRelease = deferred<void>();
		const result = SELF.fetch(citationRequest());

		// When: the actual Worker has admitted the usage request and reaches its fixture barrier.
		await usageArrival.promise;
		const pending = pendingSyncSchema.parse(await storedState());

		// Then: its one quota-sync reservation and state token match, and completion consumes it.
		expect(pending.pendingReservations).toHaveLength(1);
		const [reservation] = pending.pendingReservations;
		if (reservation === undefined) throw new Error("Expected a quota-sync reservation.");
		expect(reservation.token).toBe(pending.quota.token);
		usageRelease.resolve();
		expect((await result).status).toBe(200);
		expect(
			z.object({ pendingReservations: z.array(z.unknown()) }).parse(await storedState()),
		).toMatchObject({
			pendingReservations: [],
		});
		expect(outbound.map((request) => request.method)).toEqual(["GET", "POST"]);
	});

	it("reconciles a data 429 with one new quota-sync GET and no second POST", async () => {
		// Given: a data 429 and a barrier on its immediate reconciliation usage request.
		citationRetryAfter = "7";
		holdUsageCall = 2;
		usageArrival = deferred<void>();
		usageRelease = deferred<void>();
		const result = SELF.fetch(citationRequest());

		// When: the second usage request pauses after data quota state is recorded.
		await usageArrival.promise;
		const pending = pendingSyncSchema.parse(await storedState());

		// Then: the new correlated sync is the only pending reservation and lookup is not retried.
		expect(pending.pendingReservations).toHaveLength(1);
		expect(pending.pendingReservations[0]?.token).toBe(pending.quota.token);
		expect(outbound.map((request) => request.method)).toEqual(["GET", "POST", "GET"]);
		usageRelease.resolve();
		expect((await result).status).toBe(200);
		expect(outbound.map((request) => request.method)).toEqual(["GET", "POST", "GET"]);
	});

	it.each([null, "malformed"] as const)(
		"uses the 900-second fallback for data 429 Retry-After %s",
		async (retryAfter) => {
			// Given: a data 429 without a usable Retry-After value.
			citationRetryAfter = retryAfter;

			// When: the verified Worker flow reaches CourtListener.
			const response = await SELF.fetch(citationRequest());

			// Then: it fails closed for 900 seconds after one reconciliation and no data retry.
			expect(await response.json()).toMatchObject({
				result: {
					isError: true,
					structuredContent: {
						outcome: "indeterminate",
						reason: "rate_limited",
						retry: { action: "retry_later", retryAfterSeconds: 900 },
					},
				},
			});
			expect(outbound.map((request) => request.method)).toEqual(["GET", "POST", "GET"]);
		},
	);

	it.each([null, "malformed"] as const)(
		"prevents POST after usage 429 Retry-After %s",
		async (retryAfter) => {
			// Given: the initial quota usage endpoint rate-limits without usable guidance.
			usageRetryAfter = retryAfter;

			// When: a supported citation reaches the Worker surface.
			const response = await SELF.fetch(citationRequest());

			// Then: it returns the conservative 900-second contract without a citation POST.
			expect(await response.json()).toMatchObject({
				result: {
					isError: true,
					structuredContent: {
						outcome: "indeterminate",
						reason: "rate_limited",
						retry: { action: "retry_later", retryAfterSeconds: 900 },
					},
				},
			});
			expect(outbound.map((request) => request.method)).toEqual(["GET"]);
		},
	);
});

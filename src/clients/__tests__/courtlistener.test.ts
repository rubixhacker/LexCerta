import { BrokenCircuitError } from "cockatiel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, RateLimitError } from "../../resilience/circuit-breaker";
import { CourtListenerClient } from "../courtlistener";
import type { ExecutionPolicy } from "../courtlistener";

// Pass-through policy for isolated client testing
function createPassthroughPolicy(): ExecutionPolicy {
	return {
		execute: <T>(fn: (ctx: { signal: AbortSignal }) => Promise<T>) =>
			fn({ signal: new AbortController().signal }),
	};
}

function createMockRateLimiter(tokensAvailable = true) {
	return {
		tryConsume: vi.fn(() => tokensAvailable),
		msUntilNextToken: vi.fn(() => (tokensAvailable ? 0 : 720)),
	};
}

describe("CourtListenerClient", () => {
	let mockFetch: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mockFetch = vi.fn();
		vi.stubGlobal("fetch", mockFetch);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns rate_limited without calling fetch when rate limiter denies", async () => {
		const rateLimiter = createMockRateLimiter(false);
		const client = new CourtListenerClient("test-key", createPassthroughPolicy(), rateLimiter);

		const result = await client.lookupCitation("347 U.S. 483");

		expect(result.status).toBe("rate_limited");
		expect(mockFetch).not.toHaveBeenCalled();
		if (result.status === "rate_limited") {
			expect(result.retryAfterMs).toBe(720);
		}
	});

	it("returns ok with citation matches on HTTP 200", async () => {
		const matches = [
			{
				citation: "347 U.S. 483",
				normalized_citations: ["347 U.S. 483"],
				start_index: 0,
				end_index: 13,
				status: 200,
				error_message: "",
				clusters: [
					{
						absolute_url: "/opinion/1234/",
						case_name: "Brown v. Board of Education",
						case_name_short: "Brown",
						date_filed: "1954-05-17",
						docket: { court: "Supreme Court", court_id: "scotus" },
						citations: [{ volume: 347, reporter: "U.S.", page: "483" }],
					},
				],
			},
		];

		mockFetch.mockResolvedValue({
			status: 200,
			json: () => Promise.resolve(matches),
		});

		const client = new CourtListenerClient(
			"test-key",
			createPassthroughPolicy(),
			createMockRateLimiter(true),
		);

		const result = await client.lookupCitation("347 U.S. 483");

		expect(result.status).toBe("ok");
		if (result.status === "ok") {
			expect(result.matches).toEqual(matches);
		}
	});

	it("returns rate_limited when API returns 429", async () => {
		mockFetch.mockResolvedValue({
			status: 429,
			headers: { get: (name: string) => (name === "Retry-After" ? "60" : null) },
		});

		const client = new CourtListenerClient(
			"test-key",
			createPassthroughPolicy(),
			createMockRateLimiter(true),
		);

		const result = await client.lookupCitation("347 U.S. 483");

		expect(result.status).toBe("rate_limited");
		if (result.status === "rate_limited") {
			expect(result.retryAfterMs).toBe(60_000);
		}
	});

	it("returns error when API returns 500 (after retries exhausted)", async () => {
		mockFetch.mockResolvedValue({
			status: 500,
			text: () => Promise.resolve("Internal Server Error"),
		});

		// Use a policy that re-throws instead of retrying (simulates retries exhausted)
		const policy: ExecutionPolicy = {
			execute: <T>(fn: (ctx: { signal: AbortSignal }) => Promise<T>) =>
				fn({ signal: new AbortController().signal }),
		};

		const client = new CourtListenerClient("test-key", policy, createMockRateLimiter(true));

		const result = await client.lookupCitation("347 U.S. 483");

		expect(result.status).toBe("error");
		if (result.status === "error") {
			expect(result.code).toBe("API_ERROR");
		}
	});

	it("sends correct Authorization header, Content-Type, and form-encoded body", async () => {
		mockFetch.mockResolvedValue({
			status: 200,
			json: () => Promise.resolve([]),
		});

		const client = new CourtListenerClient(
			"my-api-key",
			createPassthroughPolicy(),
			createMockRateLimiter(true),
			"https://example.com/api",
		);

		await client.lookupCitation("347 U.S. 483");

		expect(mockFetch).toHaveBeenCalledWith(
			"https://example.com/api/citation-lookup/",
			expect.objectContaining({
				method: "POST",
				headers: {
					Authorization: "Token my-api-key",
					"Content-Type": "application/x-www-form-urlencoded",
				},
				body: "text=347%20U.S.%20483",
			}),
		);
	});

	it("returns error when circuit breaker is open (BrokenCircuitError)", async () => {
		const policy: ExecutionPolicy = {
			execute: async <T>(): Promise<T> => {
				throw new BrokenCircuitError();
			},
		};

		const client = new CourtListenerClient("test-key", policy, createMockRateLimiter(true));

		const result = await client.lookupCitation("347 U.S. 483");

		expect(result.status).toBe("error");
		if (result.status === "error") {
			expect(result.code).toBe("API_ERROR");
			expect(result.message).toBeTruthy();
		}
	});

	it("returns rate_limited with default retryAfterMs when 429 has no Retry-After header", async () => {
		mockFetch.mockResolvedValue({
			status: 429,
			headers: { get: () => null },
		});

		const client = new CourtListenerClient(
			"test-key",
			createPassthroughPolicy(),
			createMockRateLimiter(true),
		);

		const result = await client.lookupCitation("347 U.S. 483");

		expect(result.status).toBe("rate_limited");
		if (result.status === "rate_limited") {
			expect(result.retryAfterMs).toBe(60_000);
		}
	});
});

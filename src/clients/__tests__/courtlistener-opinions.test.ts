import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimitError } from "../../resilience/circuit-breaker.js";
import { CourtListenerClient } from "../courtlistener.js";
import type { ExecutionPolicy } from "../courtlistener.js";

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

function makeClusterResponse(subOpinionUrls: string[]) {
	return {
		id: 100,
		sub_opinions: subOpinionUrls,
	};
}

function makeOpinionResponse(
	id: number,
	type: string,
	opts: { plain_text?: string; html?: string } = {},
) {
	return {
		id,
		type,
		plain_text: opts.plain_text ?? "",
		html: opts.html ?? "",
		cluster: "https://www.courtlistener.com/api/rest/v4/clusters/100/",
	};
}

describe("CourtListenerClient.fetchClusterOpinions", () => {
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

		const result = await client.fetchClusterOpinions(100);

		expect(result.status).toBe("rate_limited");
		expect(mockFetch).not.toHaveBeenCalled();
		if (result.status === "rate_limited") {
			expect(result.retryAfterMs).toBe(720);
		}
	});

	it("returns not_found when cluster returns 404", async () => {
		mockFetch.mockResolvedValue({
			status: 404,
			ok: false,
		});

		const client = new CourtListenerClient(
			"test-key",
			createPassthroughPolicy(),
			createMockRateLimiter(true),
		);

		const result = await client.fetchClusterOpinions(999);

		expect(result.status).toBe("not_found");
	});

	it("returns ok with 2 OpinionText entries when cluster has 2 sub_opinions with plain_text", async () => {
		const clusterData = makeClusterResponse([
			"https://www.courtlistener.com/api/rest/v4/opinions/10/",
			"https://www.courtlistener.com/api/rest/v4/opinions/20/",
		]);

		mockFetch
			.mockResolvedValueOnce({
				status: 200,
				ok: true,
				json: () => Promise.resolve(clusterData),
			})
			.mockResolvedValueOnce({
				status: 200,
				ok: true,
				json: () =>
					Promise.resolve(
						makeOpinionResponse(10, "020lead", {
							plain_text: "The court finds that...",
						}),
					),
			})
			.mockResolvedValueOnce({
				status: 200,
				ok: true,
				json: () =>
					Promise.resolve(
						makeOpinionResponse(20, "040dissent", {
							plain_text: "I respectfully dissent...",
						}),
					),
			});

		const client = new CourtListenerClient(
			"test-key",
			createPassthroughPolicy(),
			createMockRateLimiter(true),
		);

		const result = await client.fetchClusterOpinions(100);

		expect(result.status).toBe("ok");
		if (result.status === "ok") {
			expect(result.opinions).toHaveLength(2);
			expect(result.opinions[0]).toEqual({
				opinionId: 10,
				type: "020lead",
				plainText: "The court finds that...",
				clusterId: 100,
			});
			expect(result.opinions[1]).toEqual({
				opinionId: 20,
				type: "040dissent",
				plainText: "I respectfully dissent...",
				clusterId: 100,
			});
		}
	});

	it("falls back to stripped HTML when plain_text is empty", async () => {
		const clusterData = makeClusterResponse([
			"https://www.courtlistener.com/api/rest/v4/opinions/10/",
		]);

		mockFetch
			.mockResolvedValueOnce({
				status: 200,
				ok: true,
				json: () => Promise.resolve(clusterData),
			})
			.mockResolvedValueOnce({
				status: 200,
				ok: true,
				json: () =>
					Promise.resolve(
						makeOpinionResponse(10, "010combined", {
							plain_text: "",
							html: "<p>The court <b>holds</b> that&mdash;yes.</p>",
						}),
					),
			});

		const client = new CourtListenerClient(
			"test-key",
			createPassthroughPolicy(),
			createMockRateLimiter(true),
		);

		const result = await client.fetchClusterOpinions(100);

		expect(result.status).toBe("ok");
		if (result.status === "ok") {
			expect(result.opinions).toHaveLength(1);
			expect(result.opinions[0].plainText).toBe("The court holds that yes.");
		}
	});

	it("skips sub_opinion with no text at all", async () => {
		const clusterData = makeClusterResponse([
			"https://www.courtlistener.com/api/rest/v4/opinions/10/",
			"https://www.courtlistener.com/api/rest/v4/opinions/20/",
		]);

		mockFetch
			.mockResolvedValueOnce({
				status: 200,
				ok: true,
				json: () => Promise.resolve(clusterData),
			})
			.mockResolvedValueOnce({
				status: 200,
				ok: true,
				json: () =>
					Promise.resolve(
						makeOpinionResponse(10, "020lead", {
							plain_text: "Some opinion text.",
						}),
					),
			})
			.mockResolvedValueOnce({
				status: 200,
				ok: true,
				json: () =>
					Promise.resolve(
						makeOpinionResponse(20, "040dissent", {
							plain_text: "",
							html: "",
						}),
					),
			});

		const client = new CourtListenerClient(
			"test-key",
			createPassthroughPolicy(),
			createMockRateLimiter(true),
		);

		const result = await client.fetchClusterOpinions(100);

		expect(result.status).toBe("ok");
		if (result.status === "ok") {
			expect(result.opinions).toHaveLength(1);
			expect(result.opinions[0].opinionId).toBe(10);
		}
	});

	it("returns error when cluster returns 5xx", async () => {
		mockFetch.mockResolvedValue({
			status: 500,
			ok: false,
		});

		const client = new CourtListenerClient(
			"test-key",
			createPassthroughPolicy(),
			createMockRateLimiter(true),
		);

		const result = await client.fetchClusterOpinions(100);

		expect(result.status).toBe("error");
		if (result.status === "error") {
			expect(result.code).toBe("API_ERROR");
		}
	});

	it("returns rate_limited when cluster returns 429", async () => {
		mockFetch.mockResolvedValue({
			status: 429,
			ok: false,
			headers: { get: (name: string) => (name === "Retry-After" ? "30" : null) },
		});

		const client = new CourtListenerClient(
			"test-key",
			createPassthroughPolicy(),
			createMockRateLimiter(true),
		);

		const result = await client.fetchClusterOpinions(100);

		expect(result.status).toBe("rate_limited");
		if (result.status === "rate_limited") {
			expect(result.retryAfterMs).toBe(30_000);
		}
	});
});

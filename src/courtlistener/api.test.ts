import { describe, expect, it } from "vitest";
import { type CourtListenerTransport, createCourtListenerApi } from "./api.js";

const BROWN_CITATION = { normalized: "347 U.S. 483" };

function givenTransport(response: Response) {
	const requests: Request[] = [];
	const transport: CourtListenerTransport = async (request) => {
		requests.push(request);
		return response;
	};
	return { transport, requests };
}

describe("CourtListener REST adapter", () => {
	it("posts one normalized citation as an authenticated form request and returns only trusted metadata", async () => {
		// Given: a fixed upstream citation match response.
		const given = givenTransport(
			new Response(
				JSON.stringify([
					{
						citation: "347 U.S. 483",
						normalized_citations: ["347 U.S. 483"],
						status: 200,
						clusters: [
							{
								id: 123,
								absolute_url: "/opinion/123/brown-v-board-of-education/",
								case_name: "must not be returned",
							},
						],
					},
				]),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);
		const api = createCourtListenerApi({
			token: "courtlistener-secret",
			transport: given.transport,
		});

		// When: the normalized citation is looked up.
		const result = await api.lookupCitation(BROWN_CITATION);

		// Then: the sole attempt has the CourtListener wire contract and safe provenance.
		expect(given.requests).toHaveLength(1);
		const request = given.requests[0];
		expect(request?.url).toBe("https://www.courtlistener.com/api/rest/v4/citation-lookup/");
		expect(request?.method).toBe("POST");
		expect(request?.headers.get("authorization")).toBe("Token courtlistener-secret");
		expect(request?.headers.get("accept")).toBe("application/json");
		expect(request?.headers.get("content-type")).toBe(
			"application/x-www-form-urlencoded;charset=UTF-8",
		);
		expect(await request?.text()).toBe("text=347+U.S.+483");
		expect(result).toEqual({
			kind: "matched",
			normalizedCitation: "347 U.S. 483",
			clusters: [
				{
					id: 123,
					canonicalUrl: "https://www.courtlistener.com/opinion/123/brown-v-board-of-education/",
				},
			],
		});
	});

	it.each([
		["an empty response", [], { kind: "malformed_response" }],
		[
			"a source-scoped absence",
			[{ status: 404, normalized_citations: ["1 U.S. 200"], clusters: [] }],
			{ kind: "absent", normalizedCitation: "347 U.S. 483" },
		],
		[
			"an ambiguous item",
			[
				{
					status: 300,
					normalized_citations: ["1 H. 150", "1 H. 150a"],
					clusters: [],
				},
			],
			{
				kind: "ambiguous",
				normalizedCitations: ["1 H. 150", "1 H. 150a"],
			},
		],
		[
			"an unknown reporter",
			[{ status: 400, normalized_citations: [], clusters: [] }],
			{ kind: "unknown_reporter", normalizedCitation: "347 U.S. 483" },
		],
		[
			"an item cap",
			[{ status: 429, normalized_citations: [], clusters: [] }],
			{ kind: "item_cap", normalizedCitation: "347 U.S. 483" },
		],
		[
			"a successful item with no clusters",
			[{ status: 200, normalized_citations: ["347 U.S. 483"], clusters: [] }],
			{ kind: "malformed_response" },
		],
		[
			"a successful item with one incomplete cluster provenance record",
			[
				{
					status: 200,
					normalized_citations: ["347 U.S. 483"],
					clusters: [
						{ id: 123, absolute_url: "/opinion/123/brown-v-board-of-education/" },
						{ id: 456 },
					],
				},
			],
			{ kind: "malformed_response" },
		],
	] as const)("returns %s without a second attempt", async (_name, body, expected) => {
		// Given: one successful HTTP response with a per-item CourtListener outcome.
		const given = givenTransport(
			new Response(JSON.stringify(body), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);

		// When: the citation is looked up.
		const result = await createCourtListenerApi({
			token: "token",
			transport: given.transport,
		}).lookupCitation(BROWN_CITATION);

		// Then: the typed source observation preserves its distinct semantics.
		expect(result).toEqual(expected);
		expect(given.requests).toHaveLength(1);
	});

	it("returns sanitized rate-limit guidance from a safe Retry-After header without retrying", async () => {
		// Given: one upstream HTTP rate-limit response.
		const given = givenTransport(
			new Response(null, { status: 429, headers: { "retry-after": "17" } }),
		);

		// When: the citation is looked up.
		const result = await createCourtListenerApi({
			token: "token",
			transport: given.transport,
		}).lookupCitation(BROWN_CITATION);

		// Then: the caller receives only sanitized retry guidance and one attempt occurred.
		expect(result).toEqual({ kind: "rate_limited", retryAfterSeconds: 17 });
		expect(given.requests).toHaveLength(1);
	});

	it("parses an HTTP-date Retry-After against injected time", async () => {
		// Given: an upstream rate limit with an HTTP-date retry header.
		const given = givenTransport(
			new Response(null, {
				status: 429,
				headers: { "retry-after": "Mon, 01 Jan 2024 00:00:17 GMT" },
			}),
		);

		// When: the citation is looked up with a deterministic clock.
		const result = await createCourtListenerApi({
			token: "token",
			transport: given.transport,
			now: () => new Date("2024-01-01T00:00:00.000Z"),
		}).lookupCitation(BROWN_CITATION);

		// Then: the sanitized retry guidance is deterministic and one attempt occurred.
		expect(result).toEqual({ kind: "rate_limited", retryAfterSeconds: 17 });
		expect(given.requests).toHaveLength(1);
	});

	it.each([
		[
			"a server response",
			async (_request: Request): Promise<Response> => new Response("ignored", { status: 503 }),
			{ kind: "unavailable", failure: "server", status: 503 },
		],
		[
			"a transport failure",
			async (_request: Request): Promise<Response> =>
				Promise.reject(new TypeError("connection reset")),
			{ kind: "unavailable", failure: "transport" },
		],
	])(
		"returns a classified unavailable outcome for %s without retrying",
		async (_name, transport, expected) => {
			// Given: a transport that cannot produce a usable response.
			let attempts = 0;
			const countedTransport: CourtListenerTransport = async (request) => {
				attempts += 1;
				return transport(request);
			};

			// When: the citation is looked up.
			const result = await createCourtListenerApi({
				token: "token",
				transport: countedTransport,
			}).lookupCitation(BROWN_CITATION);

			// Then: it is operationally unavailable after exactly one attempt.
			expect(result).toEqual(expected);
			expect(attempts).toBe(1);
		},
	);

	it("classifies a malformed success body without retrying", async () => {
		// Given: one malformed JSON body.
		const given = givenTransport(new Response("{", { status: 200 }));

		// When: the citation is looked up.
		const result = await createCourtListenerApi({
			token: "token",
			transport: given.transport,
		}).lookupCitation(BROWN_CITATION);

		// Then: the untrusted response does not become an absence or a second request.
		expect(result).toEqual({ kind: "malformed_response" });
		expect(given.requests).toHaveLength(1);
	});

	it("gets and parses current API usage once", async () => {
		// Given: a fixed authenticated usage response.
		const given = givenTransport(
			new Response(
				JSON.stringify({
					current_usage: [
						{
							scope: "user",
							rate: "minute",
							used: 1,
							limit: 5,
							remaining: 4,
							window_seconds: 60,
							reset_at: null,
							blocked: false,
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);

		// When: live usage is fetched.
		const result = await createCourtListenerApi({
			token: "usage-secret",
			transport: given.transport,
		}).getUsage();

		// Then: the exact GET contract and parsed usage observation are returned.
		expect(given.requests).toHaveLength(1);
		const request = given.requests[0];
		expect(request?.url).toBe("https://www.courtlistener.com/api/rest/v4/api-usage/");
		expect(request?.method).toBe("GET");
		expect(request?.headers.get("authorization")).toBe("Token usage-secret");
		expect(result).toEqual({
			kind: "usage",
			currentUsage: [
				{
					scope: "user",
					rate: "minute",
					used: 1,
					limit: 5,
					remaining: 4,
					windowSeconds: 60,
					resetAt: null,
					blocked: false,
				},
			],
		});
	});

	it("aborts a timed-out single attempt and returns a sanitized outcome", async () => {
		// Given: a transport that resolves only after its request is aborted.
		let attempts = 0;
		const transport: CourtListenerTransport = (request) =>
			new Promise((_resolve, reject) => {
				attempts += 1;
				request.signal.addEventListener("abort", () => reject(request.signal.reason), {
					once: true,
				});
			});

		// When: a bounded lookup reaches its timeout.
		const result = await createCourtListenerApi({
			token: "token",
			transport,
			timeoutMs: 1,
		}).lookupCitation(BROWN_CITATION);

		// Then: the attempt is cancelled, classified, and never retried.
		expect(result).toEqual({ kind: "unavailable", failure: "timeout" });
		expect(attempts).toBe(1);
	});
});

import { describe, expect, it } from "vitest";
import { type CourtListenerTransport, createCourtListenerApi } from "./api.js";

const CITATION = { normalized: "347 U.S. 483" };

function givenTransport(response: Response) {
	const requests: Request[] = [];
	const transport: CourtListenerTransport = async (request) => {
		requests.push(request);
		return response;
	};
	return { transport, requests };
}

function conclusiveResponse(status: 200 | 404, normalizedCitations: readonly string[]): Response {
	return Response.json([
		{
			status,
			normalized_citations: normalizedCitations,
			clusters:
				status === 200
					? [{ id: 123, absolute_url: "/opinion/123/brown-v-board-of-education/" }]
					: [],
		},
	]);
}

describe("CourtListener conclusive response binding", () => {
	it.each([
		[200, ["1 U.S. 200"]],
		[404, ["1 U.S. 200"]],
	] as const)(
		"rejects mismatched conclusive status %i without retrying",
		async (status, normalized) => {
			// Given: CourtListener returns a conclusive item for a different canonical citation.
			const given = givenTransport(conclusiveResponse(status, normalized));

			// When: the adapter looks up the requested citation.
			const result = await createCourtListenerApi({
				token: "token",
				transport: given.transport,
			}).lookupCitation(CITATION);

			// Then: the unbound item is malformed and the adapter made one attempt.
			expect(result).toEqual({ kind: "malformed_response" });
			expect(given.requests).toHaveLength(1);
		},
	);

	it.each([
		[200, []],
		[200, [CITATION.normalized, "1 U.S. 200"]],
		[404, []],
		[404, [CITATION.normalized, "1 U.S. 200"]],
	] as const)(
		"rejects conclusive status %i with non-singleton normalization %j",
		async (status, normalized) => {
			// Given: CourtListener returns a conclusive item with empty or multiple normalized citations.
			const given = givenTransport(conclusiveResponse(status, normalized));

			// When: the adapter looks up one requested normalized citation.
			const result = await createCourtListenerApi({
				token: "token",
				transport: given.transport,
			}).lookupCitation(CITATION);

			// Then: the ambiguous source binding is malformed and never retried.
			expect(result).toEqual({ kind: "malformed_response" });
			expect(given.requests).toHaveLength(1);
		},
	);
});

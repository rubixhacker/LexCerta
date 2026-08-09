import { describe, expect, it } from "vitest";
import { type CourtListenerTransport, createCourtListenerApi } from "./api.js";
import { MAX_RESPONSE_BODY_BYTES } from "./response-body.js";

const citation = { normalized: "347 U.S. 483" };
const encoded = new TextEncoder();

function oversizedResponse(json: string, contentLength?: string) {
	let cancelled = false;
	const bytes = encoded.encode(json);
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes.slice(0, 32));
			controller.enqueue(bytes.slice(32));
		},
		cancel() {
			cancelled = true;
		},
	});
	return {
		response: new Response(stream, {
			headers: contentLength === undefined ? {} : { "content-length": contentLength },
		}),
		wasCancelled: () => cancelled,
	};
}

function api(response: Response) {
	const transport: CourtListenerTransport = async () => response;
	return createCourtListenerApi({ token: "token", transport });
}

describe("CourtListener response body cap", () => {
	it("cancels an undeclared oversized citation stream before it can become a match", async () => {
		// Given: a valid match response streamed beyond the explicit byte cap without Content-Length.
		const source = oversizedResponse(
			JSON.stringify([
				{
					status: 200,
					normalized_citations: [citation.normalized],
					clusters: [{ id: 123, absolute_url: "/opinion/123/brown-v-board-of-education/" }],
					padding: "x".repeat(MAX_RESPONSE_BODY_BYTES),
				},
			]),
		);

		// When: the adapter performs its sole citation lookup attempt.
		const result = await api(source.response).lookupCitation(citation);

		// Then: it cancels the body and reports malformed response rather than a match.
		expect(result).toEqual({ kind: "malformed_response" });
		expect(source.wasCancelled()).toBe(true);
	});

	it("cancels a lying-length oversized usage stream before it can become usable quota", async () => {
		// Given: a valid usage response streamed beyond the cap despite a small declared Content-Length.
		const source = oversizedResponse(
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
				padding: "x".repeat(MAX_RESPONSE_BODY_BYTES),
			}),
			"1",
		);

		// When: the adapter performs its sole usage request.
		const result = await api(source.response).getUsage();

		// Then: it cancels the body and rejects the quota data.
		expect(result).toEqual({ kind: "malformed_response" });
		expect(source.wasCancelled()).toBe(true);
	});

	it("rejects a citation response whose declared Content-Length exceeds the cap", async () => {
		// Given: a response that declares an excessive body before it is read.
		const source = oversizedResponse("[]", String(MAX_RESPONSE_BODY_BYTES + 1));

		// When: the adapter performs its sole citation lookup attempt.
		const result = await api(source.response).lookupCitation(citation);

		// Then: it cancels the declared oversized body and returns malformed response.
		expect(result).toEqual({ kind: "malformed_response" });
		expect(source.wasCancelled()).toBe(true);
	});
});

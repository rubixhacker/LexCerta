import { describe, expect, it } from "vitest";
import { createCourtListenerCaseLawApi } from "./case-law-api.js";

const encoded = new TextEncoder();

function oversizedResponse(body: string, contentLength?: string) {
	let cancelled = false;
	const bytes = encoded.encode(body);
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
	return createCourtListenerCaseLawApi({
		maxResponseBytes: 1_024,
		token: "fixture-token",
		transport: async () => response,
	});
}

describe("case-law response body ceilings", () => {
	it("cancels a declared oversized cluster body before decoding", async () => {
		// Given: the response declares more bytes than the configured per-request body cap.
		const source = oversizedResponse("{}", "1025");

		// When: the adapter performs its sole trusted cluster GET.
		const result = await api(source.response).getCluster(123);

		// Then: the stream is cancelled, malformed is sanitized, and no retry occurs.
		expect(result).toEqual({ kind: "malformed_response" });
		expect(source.wasCancelled()).toBe(true);
	});

	it("cancels an undeclared streamed oversized opinion body", async () => {
		// Given: a valid-looking opinion stream exceeds the same cap without Content-Length.
		const source = oversizedResponse(
			JSON.stringify({
				cluster: "https://www.courtlistener.com/api/rest/v4/clusters/123/",
				id: 456,
				plain_text: "x".repeat(1_024),
			}),
		);

		// When: the adapter performs its sole trusted opinion GET.
		const result = await api(source.response).getOpinion(
			"https://www.courtlistener.com/api/rest/v4/opinions/456/",
		);

		// Then: the reader is cancelled before source processing and no retry happens.
		expect(result).toEqual({ kind: "malformed_response" });
		expect(source.wasCancelled()).toBe(true);
	});
});

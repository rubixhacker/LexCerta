import { describe, expect, it, vi } from "vitest";
import {
	MAX_TELEMETRY_RESPONSE_BYTES,
	summarizeTelemetryPayload,
	summarizeTelemetryResponse,
} from "../src/telemetry/response-mapping.js";

describe("telemetry response mapping", () => {
	it("maps a source contradiction to fixed safe telemetry dimensions", async () => {
		// Given: a successful quote-tool response whose public contract reports a source contradiction.
		const response = Response.json({
			result: {
				structuredContent: {
					outcome: "indeterminate",
					reason: "source_changed",
				},
			},
		});

		// When: the response is reduced for operational telemetry.
		const summary = await summarizeTelemetryResponse(response, "verify_quote");

		// Then: only fixed aggregate dimensions describe the contradiction.
		expect(summary).toEqual({
			cacheStatus: "source_changed",
			circuitStatus: "not_called",
			errorCategory: "cache",
			freshness: "source_changed",
			outcome: "indeterminate",
			responseBytes: 86,
			upstreamStatus: "success",
		});
	});

	it("records a bodyless payload rejection without attempting to parse a request body", async () => {
		const summary = await summarizeTelemetryResponse(
			new Response(null, { status: 413 }),
			"verify_quote",
		);

		expect(summary).toEqual({
			cacheStatus: "not_used",
			circuitStatus: "not_called",
			errorCategory: "payload",
			freshness: "not_applicable",
			outcome: "payload_too_large",
			responseBytes: 0,
			upstreamStatus: "not_called",
		});
	});

	it.each([
		[401, "unauthorized", "authentication"],
		[503, "authentication_unavailable", "authentication"],
		[429, "admission_exhausted", "admission"],
		[503, "admission_unavailable", "admission"],
	] as const)("maps a bodyless %i %s boundary response", async (status, outcome, errorCategory) => {
		// Given: a bodyless authentication or admission boundary response.
		const response = new Response(null, { status });

		// When: the Worker supplies the boundary outcome that a public status cannot distinguish.
		const summary = await summarizeTelemetryResponse(response, "mcp", outcome);

		// Then: the event preserves the correct fixed error category without parsing a body.
		expect(summary).toMatchObject({ errorCategory, outcome, responseBytes: 0 });
	});

	it.each([
		["circuit_open", "not_used", "open", "not_called"],
		["quota_limited", "miss", "closed", "quota_limited"],
		["quota_unknown", "miss", "closed", "quota_unknown"],
		["rate_limited", "miss", "closed", "rate_limited"],
		["timeout", "miss", "closed", "timeout"],
		["upstream_unavailable", "miss", "closed", "unavailable"],
	] as const)(
		"maps the %s evidence-source condition to bounded dimensions",
		(reason, cacheStatus, circuitStatus, upstreamStatus) => {
			// Given: an indeterminate public verification result.
			const payload = { result: { structuredContent: { outcome: "indeterminate", reason } } };

			// When: the response is projected into aggregate telemetry.
			const summary = summarizeTelemetryPayload(payload, 200, "verify_quote", 0);

			// Then: the evidence-source condition is visible without legal content.
			expect(summary).toMatchObject({
				cacheStatus,
				circuitStatus,
				errorCategory: "upstream",
				upstreamStatus,
			});
		},
	);

	it.each(["fresh", "stale"] as const)(
		"does not mistake %s evidence for a cache hit",
		(freshness) => {
			// Given: evidence provenance that states age but not how this request obtained it.
			const payload = {
				result: { structuredContent: { outcome: "verified", evidence: { freshness } } },
			};

			// When: telemetry maps the verification response.
			const summary = summarizeTelemetryPayload(payload, 200, "verify_quote", 0);

			// Then: it makes no unsupported cache-hit or upstream-call claim.
			expect(summary).toMatchObject({
				cacheStatus: "not_used",
				freshness,
				upstreamStatus: "not_called",
			});
		},
	);

	it("does not inspect a non-JSON response body for telemetry dimensions", async () => {
		const response = new Response(
			JSON.stringify({
				result: { structuredContent: { outcome: "indeterminate", reason: "source_changed" } },
			}),
			{ headers: { "content-type": "text/plain" } },
		);

		expect(await summarizeTelemetryResponse(response, "verify_quote")).toEqual({
			cacheStatus: "not_used",
			circuitStatus: "not_called",
			errorCategory: "none",
			freshness: "not_applicable",
			outcome: "verified",
			responseBytes: 86,
			upstreamStatus: "not_called",
		});
	});

	it("rejects a declared oversized JSON body before reading it", async () => {
		const response = new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("oversized-body"));
					controller.close();
				},
			}),
			{
				headers: {
					"content-length": String(MAX_TELEMETRY_RESPONSE_BYTES + 1),
					"content-type": "application/json",
				},
			},
		);

		const summary = await summarizeTelemetryResponse(response, "verify_quote");

		expect(summary).toMatchObject({
			outcome: "verified",
			responseBytes: MAX_TELEMETRY_RESPONSE_BYTES,
		});
		expect(await response.text()).toBe("oversized-body");
	});

	it("cancels a lying-length JSON stream at the byte cap and preserves the response", async () => {
		const encoder = new TextEncoder();
		let cancelled = false;
		const chunks = [
			encoder.encode('{"result":{"structuredContent":{"outcome":"verified"}}}'),
			encoder.encode("x".repeat(MAX_TELEMETRY_RESPONSE_BYTES)),
		];
		const response = new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(chunks[0]);
				},
				pull(controller) {
					controller.enqueue(chunks[1]);
				},
				cancel() {
					cancelled = true;
				},
			}),
			{
				headers: {
					"content-length": "1",
					"content-type": "application/json",
				},
			},
		);

		const summary = await summarizeTelemetryResponse(response, "verify_quote");

		expect(summary).toMatchObject({
			outcome: "verified",
			responseBytes: MAX_TELEMETRY_RESPONSE_BYTES,
		});
		const originalBody = response.body;
		if (originalBody !== null) await originalBody.cancel();
		expect(cancelled).toBe(true);
	});

	it("counts a large non-JSON chunk without decoding or retaining its content", async () => {
		const response = new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new Uint8Array(MAX_TELEMETRY_RESPONSE_BYTES + 1));
					controller.close();
				},
			}),
			{ headers: { "content-type": "text/plain" } },
		);

		const summary = await summarizeTelemetryResponse(response, "verify_quote");

		expect(summary).toMatchObject({
			outcome: "verified",
			responseBytes: MAX_TELEMETRY_RESPONSE_BYTES,
		});
	});

	it("abandons a never-resolving response read by its deadline", async () => {
		const response = new Response(
			new ReadableStream<Uint8Array>({
				pull() {
					return new Promise<void>(() => undefined);
				},
			}),
			{ headers: { "content-type": "application/json" } },
		);

		const started = performance.now();
		const summary = await summarizeTelemetryResponse(response, "verify_quote");

		expect(summary).toMatchObject({ outcome: "verified", responseBytes: 0 });
		expect(performance.now() - started).toBeLessThan(2_000);
	});

	it("enforces one total deadline across a slow-drip response", async () => {
		vi.useFakeTimers();
		try {
			const encoder = new TextEncoder();
			const response = new Response(
				new ReadableStream<Uint8Array>({
					pull(controller) {
						return new Promise<void>((resolve) => {
							setTimeout(() => {
								controller.enqueue(encoder.encode("{}"));
								resolve();
							}, 400);
						});
					},
				}),
				{ headers: { "content-type": "application/json" } },
			);
			let settled = false;
			const summaryPromise = summarizeTelemetryResponse(response, "verify_quote");
			void summaryPromise.then(() => {
				settled = true;
			});

			await vi.advanceTimersByTimeAsync(1_001);
			if (!settled) await vi.advanceTimersByTimeAsync(5_000);
			expect(settled).toBe(true);
			expect((await summaryPromise).responseBytes).toBe(4);
		} finally {
			vi.useRealTimers();
		}
	});
});

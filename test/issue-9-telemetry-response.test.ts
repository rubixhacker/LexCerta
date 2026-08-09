import { describe, expect, it } from "vitest";
import {
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
});

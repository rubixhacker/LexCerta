import { describe, expect, it } from "vitest";
import { createTelemetryEvent } from "./contract.js";
import { toTelemetrySpanAttributes } from "./span-attributes.js";

describe("telemetry span attributes", () => {
	it("projects a strict telemetry event into the trace allow-list", () => {
		// Given: a completed authenticated request represented only by the telemetry contract.
		const event = createTelemetryEvent({
			cacheStatus: "hit",
			circuitStatus: "closed",
			correlation: {
				requestId: "2f1b5a06-b4d1-4f13-8e3f-98f7a2980d23",
				traceId: "0af7651916cd43dd8448eb211c80319c",
			},
			errorCategory: "none",
			event: "mcp.request.completed",
			freshness: "fresh",
			keyIdentifier: "key-01",
			latencyMs: 42,
			outcome: "verified",
			responseBytes: 384,
			tool: "verify_quote",
			upstreamLatencyMs: 27,
			upstreamStatus: "success",
		});

		// When: the trace Worker prepares its custom-span attributes.
		const attributes = toTelemetrySpanAttributes(event);

		// Then: every persisted attribute is from the contract allow-list.
		expect(attributes).toEqual({
			"lexcerta.cache_status": "hit",
			"lexcerta.circuit_status": "closed",
			"lexcerta.error_category": "none",
			"lexcerta.event": "mcp.request.completed",
			"lexcerta.freshness": "fresh",
			"lexcerta.key_identifier": "key-01",
			"lexcerta.latency_ms": 42,
			"lexcerta.outcome": "verified",
			"lexcerta.request_id": "2f1b5a06-b4d1-4f13-8e3f-98f7a2980d23",
			"lexcerta.response_bytes": 384,
			"lexcerta.tool": "verify_quote",
			"lexcerta.trace_id": "0af7651916cd43dd8448eb211c80319c",
			"lexcerta.upstream_latency_ms": 27,
			"lexcerta.upstream_status": "success",
		});
	});

	it("omits upstream latency when the request made no outbound attempt", () => {
		// Given: a cache-only completion that did not await CourtListener.
		const event = createTelemetryEvent({
			cacheStatus: "hit",
			circuitStatus: "closed",
			correlation: {
				requestId: "2f1b5a06-b4d1-4f13-8e3f-98f7a2980d23",
				traceId: "0af7651916cd43dd8448eb211c80319c",
			},
			errorCategory: "none",
			event: "mcp.request.completed",
			freshness: "fresh",
			keyIdentifier: null,
			latencyMs: 42,
			outcome: "verified",
			responseBytes: 384,
			tool: "verify_quote",
			upstreamLatencyMs: null,
			upstreamStatus: "not_called",
		});

		// When: the trace Worker projects the allow-listed attributes.
		const attributes = toTelemetrySpanAttributes(event);

		// Then: no synthetic upstream-latency value is persisted.
		expect(attributes["lexcerta.upstream_latency_ms"]).toBeUndefined();
	});
});

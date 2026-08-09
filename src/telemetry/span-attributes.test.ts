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
			"lexcerta.upstream_status": "success",
		});
	});
});

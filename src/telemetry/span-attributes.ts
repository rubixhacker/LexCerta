import type { TelemetryEvent } from "./contract.js";

export type TelemetrySpanAttribute = string | number;
export type TelemetrySpanAttributes = Readonly<Record<string, TelemetrySpanAttribute>>;

export function toTelemetrySpanAttributes(event: TelemetryEvent): TelemetrySpanAttributes {
	return {
		"lexcerta.cache_status": event.cacheStatus,
		"lexcerta.circuit_status": event.circuitStatus,
		"lexcerta.error_category": event.errorCategory,
		"lexcerta.event": event.event,
		"lexcerta.freshness": event.freshness,
		...(event.keyIdentifier === null ? {} : { "lexcerta.key_identifier": event.keyIdentifier }),
		"lexcerta.latency_ms": event.latencyMs,
		"lexcerta.outcome": event.outcome,
		"lexcerta.request_id": event.correlation.requestId,
		"lexcerta.response_bytes": event.responseBytes,
		"lexcerta.tool": event.tool,
		"lexcerta.trace_id": event.correlation.traceId,
		...(event.upstreamLatencyMs === null
			? {}
			: { "lexcerta.upstream_latency_ms": event.upstreamLatencyMs }),
		"lexcerta.upstream_status": event.upstreamStatus,
	};
}

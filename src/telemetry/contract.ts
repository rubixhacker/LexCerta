import { z } from "zod";

const TELEMETRY_TOOLS = ["mcp", "parse_citation", "verify_citation", "verify_quote"] as const;
const TELEMETRY_OUTCOMES = [
	"parsed",
	"unrecognized",
	"verified",
	"not_found",
	"indeterminate",
	"unauthorized",
	"authentication_unavailable",
	"admission_exhausted",
	"admission_unavailable",
	"protocol_rejected",
	"payload_too_large",
	"internal_error",
] as const;
const CACHE_STATUSES = ["hit", "miss", "source_changed", "not_used"] as const;
const FRESHNESS_STATUSES = ["fresh", "stale", "source_changed", "not_applicable"] as const;
const CIRCUIT_STATUSES = ["closed", "open", "half_open", "not_called"] as const;
const UPSTREAM_STATUSES = [
	"not_called",
	"success",
	"rate_limited",
	"quota_limited",
	"quota_unknown",
	"unavailable",
	"timeout",
	"server_error",
	"malformed_response",
] as const;
const ERROR_CATEGORIES = [
	"none",
	"authentication",
	"admission",
	"protocol",
	"payload",
	"upstream",
	"cache",
	"internal",
] as const;

const requestIdSchema = z.uuid().brand("TelemetryRequestId");
const traceIdSchema = z
	.string()
	.regex(/^[0-9a-f]{32}$/iu)
	.brand("TelemetryTraceId");
const keyIdentifierSchema = z
	.string()
	.regex(/^[A-Za-z0-9-]{1,64}$/u)
	.brand("TelemetryKeyIdentifier");
const nonnegativeSafeInteger = z.number().int().nonnegative().safe();

const telemetryCorrelationSchema = z
	.object({ requestId: requestIdSchema, traceId: traceIdSchema })
	.strict();
const telemetryEventSchema = z
	.object({
		cacheStatus: z.enum(CACHE_STATUSES),
		circuitStatus: z.enum(CIRCUIT_STATUSES),
		correlation: telemetryCorrelationSchema,
		errorCategory: z.enum(ERROR_CATEGORIES),
		event: z.literal("mcp.request.completed"),
		freshness: z.enum(FRESHNESS_STATUSES),
		keyIdentifier: keyIdentifierSchema.nullable(),
		latencyMs: nonnegativeSafeInteger,
		outcome: z.enum(TELEMETRY_OUTCOMES),
		responseBytes: nonnegativeSafeInteger,
		tool: z.enum(TELEMETRY_TOOLS),
		upstreamStatus: z.enum(UPSTREAM_STATUSES),
	})
	.strict();

export type TelemetryTool = (typeof TELEMETRY_TOOLS)[number];
export type TelemetryOutcome = (typeof TELEMETRY_OUTCOMES)[number];
export type TelemetryCacheStatus = (typeof CACHE_STATUSES)[number];
export type TelemetryFreshnessStatus = (typeof FRESHNESS_STATUSES)[number];
export type TelemetryCircuitStatus = (typeof CIRCUIT_STATUSES)[number];
export type TelemetryUpstreamStatus = (typeof UPSTREAM_STATUSES)[number];
export type TelemetryErrorCategory = (typeof ERROR_CATEGORIES)[number];
export type TelemetryRequestId = z.infer<typeof requestIdSchema>;
export type TelemetryTraceId = z.infer<typeof traceIdSchema>;
export type TelemetryKeyIdentifier = z.infer<typeof keyIdentifierSchema>;
export type TelemetryCorrelation = Readonly<z.infer<typeof telemetryCorrelationSchema>>;
export type TelemetryEvent = Readonly<z.infer<typeof telemetryEventSchema>>;

export type AnalyticsMetric = {
	readonly blobs: readonly [
		TelemetryTool,
		TelemetryOutcome,
		TelemetryCacheStatus,
		TelemetryFreshnessStatus,
		TelemetryCircuitStatus,
		TelemetryUpstreamStatus,
		TelemetryErrorCategory,
	];
	readonly doubles: readonly [latencyMs: number, responseBytes: number, eventCount: 1];
};

export interface TelemetryEventSink {
	readonly record: (event: TelemetryEvent) => void;
}

export interface AnalyticsMetricSink {
	readonly write: (metric: AnalyticsMetric) => void;
}

export function createTelemetryCorrelation(input: unknown): TelemetryCorrelation {
	return telemetryCorrelationSchema.parse(input);
}

export function createTelemetryEvent(input: unknown): TelemetryEvent {
	return telemetryEventSchema.parse(input);
}

export function toAnalyticsMetric(event: TelemetryEvent): AnalyticsMetric {
	return {
		blobs: [
			event.tool,
			event.outcome,
			event.cacheStatus,
			event.freshness,
			event.circuitStatus,
			event.upstreamStatus,
			event.errorCategory,
		],
		doubles: [event.latencyMs, event.responseBytes, 1],
	};
}

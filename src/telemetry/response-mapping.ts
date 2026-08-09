import type {
	TelemetryCacheStatus,
	TelemetryCircuitStatus,
	TelemetryErrorCategory,
	TelemetryFreshnessStatus,
	TelemetryOutcome,
	TelemetryTool,
	TelemetryUpstreamStatus,
} from "./contract.js";

export type TelemetryResponseSummary = {
	readonly cacheStatus: TelemetryCacheStatus;
	readonly circuitStatus: TelemetryCircuitStatus;
	readonly errorCategory: TelemetryErrorCategory;
	readonly freshness: TelemetryFreshnessStatus;
	readonly outcome: TelemetryOutcome;
	readonly responseBytes: number;
	readonly upstreamStatus: TelemetryUpstreamStatus;
};

const EMPTY_SUMMARY = {
	cacheStatus: "not_used",
	circuitStatus: "not_called",
	errorCategory: "none",
	freshness: "not_applicable",
	upstreamStatus: "not_called",
} as const satisfies Omit<TelemetryResponseSummary, "outcome" | "responseBytes">;

export const MAX_TELEMETRY_RESPONSE_BYTES = 65_536;
const RESPONSE_READ_DEADLINE_MS = 1_000;

type ResponseBody = { readonly bytes: number; readonly text: string };

export async function summarizeTelemetryResponse(
	response: Response,
	tool: TelemetryTool,
	boundaryOutcome?: TelemetryOutcome,
): Promise<TelemetryResponseSummary> {
	const body = await boundedResponseBody(response, isJsonResponse(response));
	return summarizeTelemetryPayload(
		parseTelemetryPayload(body.text),
		response.status,
		tool,
		body.bytes,
		boundaryOutcome,
	);
}

function declaredLength(response: Response): number | undefined {
	const value = response.headers.get("content-length");
	if (value === null || !/^\d+$/.test(value.trim())) return undefined;
	const length = Number(value);
	return Number.isSafeInteger(length) ? length : undefined;
}

function abandon(reader: ReadableStreamDefaultReader<Uint8Array>): void {
	void reader.cancel().catch(() => undefined);
}

async function readWithDeadline(reader: ReadableStreamDefaultReader<Uint8Array>, deadline: number) {
	const remaining = deadline - performance.now();
	if (remaining <= 0) return undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<undefined>((resolve) => {
		timer = setTimeout(() => resolve(undefined), remaining);
	});
	try {
		return await Promise.race([reader.read(), expired]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

async function boundedResponseBody(response: Response, decodeJson: boolean): Promise<ResponseBody> {
	if (response.body === null) return { bytes: 0, text: "" };
	const declared = declaredLength(response);
	if (declared !== undefined && declared > MAX_TELEMETRY_RESPONSE_BYTES) {
		return { bytes: MAX_TELEMETRY_RESPONSE_BYTES, text: "" };
	}
	const clone = response.clone();
	const stream = clone.body;
	if (stream === null) return { bytes: 0, text: "" };

	const reader = stream.getReader();
	const decoder = decodeJson ? new TextDecoder() : undefined;
	const deadline = performance.now() + RESPONSE_READ_DEADLINE_MS;
	let bytes = 0;
	let text = "";
	try {
		while (true) {
			const chunk = await readWithDeadline(reader, deadline);
			if (chunk === undefined) {
				abandon(reader);
				return { bytes, text: "" };
			}
			if (chunk.done) {
				if (decoder !== undefined) text += decoder.decode();
				return { bytes, text };
			}
			bytes += chunk.value.byteLength;
			if (bytes > MAX_TELEMETRY_RESPONSE_BYTES) {
				abandon(reader);
				return { bytes: MAX_TELEMETRY_RESPONSE_BYTES, text: "" };
			}
			if (decoder !== undefined) text += decoder.decode(chunk.value, { stream: true });
		}
	} catch {
		abandon(reader);
		return { bytes, text: "" };
	} finally {
		reader.releaseLock();
	}
}

function isJsonResponse(response: Response): boolean {
	return response.headers.get("content-type")?.toLowerCase().includes("application/json") ?? false;
}

function parseTelemetryPayload(value: string): unknown {
	if (value.length === 0) return undefined;
	try {
		return JSON.parse(value);
	} catch {
		// no-excuse-ok: catch malformed responses must still emit status-only telemetry.
		return undefined;
	}
}

export function summarizeTelemetryPayload(
	payload: unknown,
	status: number,
	tool: TelemetryTool,
	responseBytes: number,
	boundaryOutcome?: TelemetryOutcome,
): TelemetryResponseSummary {
	const structured = structuredContent(payload);
	const outcome =
		boundaryOutcome ?? structuredOutcome(structured) ?? outcomeForStatus(status, tool);
	const reason = stringField(structured, "reason");
	const freshness = freshnessFor(structured, reason);
	return {
		...EMPTY_SUMMARY,
		...dimensionsFor(reason, outcome),
		freshness,
		outcome,
		responseBytes,
	};
}

function structuredContent(payload: unknown): Readonly<Record<string, unknown>> | undefined {
	const result = objectField(payload, "result");
	return objectField(result, "structuredContent");
}

function objectField(value: unknown, field: string): Readonly<Record<string, unknown>> | undefined {
	if (!isRecord(value)) return undefined;
	const candidate = value[field];
	if (!isRecord(candidate)) return undefined;
	return candidate;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(
	value: Readonly<Record<string, unknown>> | undefined,
	field: string,
): string | undefined {
	const candidate = value?.[field];
	return typeof candidate === "string" ? candidate : undefined;
}

function structuredOutcome(
	structured: Readonly<Record<string, unknown>> | undefined,
): TelemetryOutcome | undefined {
	const outcome = stringField(structured, "outcome");
	switch (outcome) {
		case "parsed":
		case "unrecognized":
		case "verified":
		case "not_found":
		case "indeterminate":
			return outcome;
		default:
			return undefined;
	}
}

function outcomeForStatus(status: number, tool: TelemetryTool): TelemetryOutcome {
	if (status === 401) return "unauthorized";
	if (status === 413) return "payload_too_large";
	if (status === 429) return "admission_exhausted";
	if (status === 503) return "admission_unavailable";
	if (status >= 400 && status < 500) return "protocol_rejected";
	if (status >= 500) return "internal_error";
	return tool === "parse_citation" ? "parsed" : "verified";
}

function freshnessFor(
	structured: Readonly<Record<string, unknown>> | undefined,
	reason: string | undefined,
): TelemetryFreshnessStatus {
	if (reason === "source_changed") return "source_changed";
	const evidence = objectField(structured, "evidence");
	const freshness = stringField(evidence, "freshness");
	switch (freshness) {
		case "fresh":
		case "stale":
			return freshness;
		default:
			return "not_applicable";
	}
}

const UPSTREAM_REASON_STATUS = new Map<string, TelemetryUpstreamStatus>([
	["rate_limited", "rate_limited"],
	["quota_unknown", "quota_unknown"],
	["quota_limited", "quota_limited"],
	["timeout", "timeout"],
	["upstream_unavailable", "unavailable"],
]);

function dimensionsFor(
	reason: string | undefined,
	outcome: TelemetryOutcome,
): Pick<
	TelemetryResponseSummary,
	"cacheStatus" | "circuitStatus" | "errorCategory" | "upstreamStatus"
> {
	if (reason === "source_changed") {
		return {
			cacheStatus: "source_changed",
			circuitStatus: "not_called",
			errorCategory: "cache",
			upstreamStatus: "success",
		};
	}
	if (reason === "circuit_open") {
		return {
			cacheStatus: "not_used",
			circuitStatus: "open",
			errorCategory: "upstream",
			upstreamStatus: "not_called",
		};
	}
	const upstreamStatus = UPSTREAM_REASON_STATUS.get(reason ?? "");
	if (upstreamStatus !== undefined) {
		return {
			cacheStatus: "miss",
			circuitStatus: "closed",
			errorCategory: "upstream",
			upstreamStatus,
		};
	}
	switch (outcome) {
		case "unauthorized":
		case "authentication_unavailable":
			return { ...EMPTY_SUMMARY, errorCategory: "authentication" };
		case "admission_exhausted":
		case "admission_unavailable":
			return { ...EMPTY_SUMMARY, errorCategory: "admission" };
		case "protocol_rejected":
			return { ...EMPTY_SUMMARY, errorCategory: "protocol" };
		case "payload_too_large":
			return { ...EMPTY_SUMMARY, errorCategory: "payload" };
		case "internal_error":
			return { ...EMPTY_SUMMARY, errorCategory: "internal" };
		default:
			return EMPTY_SUMMARY;
	}
}

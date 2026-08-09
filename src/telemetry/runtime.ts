import {
	createTelemetryCorrelation,
	createTelemetryEvent,
	toAnalyticsMetric,
	type TelemetryEvent,
	type TelemetryOutcome,
	type TelemetryTool,
} from "./contract.js";
import { summarizeTelemetryResponse } from "./response-mapping.js";

type AnalyticsEnvironment = {
	readonly TELEMETRY: AnalyticsEngineDataset;
};

type TelemetryContext = {
	waitUntil(promise: Promise<unknown>): void;
};

type RecordTelemetryInput = {
	readonly context: TelemetryContext;
	readonly boundaryOutcome: TelemetryOutcome | undefined;
	readonly environment: AnalyticsEnvironment;
	readonly keyIdentifier: string | null;
	readonly response: Response;
	readonly startedAt: number;
	readonly tool: TelemetryTool;
};

export function telemetryTool(request: Request): TelemetryTool {
	const name = request.headers.get("mcp-name");
	switch (name) {
		case "parse_citation":
		case "verify_citation":
		case "verify_quote":
			return name;
		default:
			return "mcp";
	}
}

export function recordResponseTelemetry(input: RecordTelemetryInput): void {
	input.context.waitUntil(record(input));
}

async function record(input: RecordTelemetryInput): Promise<void> {
	try {
		const summary = await summarizeTelemetryResponse(
			input.response,
			input.tool,
			input.boundaryOutcome,
		);
		const event = createTelemetryEvent({
			...summary,
			correlation: createTelemetryCorrelation({
				requestId: crypto.randomUUID(),
				traceId: crypto.randomUUID().replaceAll("-", ""),
			}),
			event: "mcp.request.completed",
			keyIdentifier: input.keyIdentifier,
			latencyMs: Math.max(0, Math.round(performance.now() - input.startedAt)),
			tool: input.tool,
		});
		recordEvent(input.environment.TELEMETRY, event);
	} catch {
		// no-excuse-ok: catch telemetry failures must never alter a completed request.
	}
}

function recordEvent(dataset: AnalyticsEngineDataset, event: TelemetryEvent): void {
	try {
		console.log(event);
	} catch {
		// no-excuse-ok: catch telemetry sink failures must never alter a completed request.
	}
	try {
		const metric = toAnalyticsMetric(event);
		dataset.writeDataPoint({ blobs: [...metric.blobs], doubles: [...metric.doubles] });
	} catch {
		// no-excuse-ok: catch telemetry sink failures must never alter a completed request.
	}
}

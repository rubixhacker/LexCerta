import {
	type TelemetryEvent,
	type TelemetryOutcome,
	type TelemetryTool,
	createTelemetryCorrelation,
	createTelemetryEvent,
	toAnalyticsMetric,
} from "./contract.js";
import type { ExecutionFacts } from "./execution-facts.js";
import { summarizeTelemetryResponse } from "./response-mapping.js";

type TelemetryEnvironment = {
	readonly TELEMETRY: AnalyticsEngineDataset;
	readonly TELEMETRY_TRACES: {
		readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
	};
};

type TelemetryContext = {
	waitUntil(promise: Promise<unknown>): void;
};

type RecordTelemetryInput = {
	readonly context: TelemetryContext;
	readonly boundaryOutcome: TelemetryOutcome | undefined;
	readonly environment: TelemetryEnvironment;
	readonly executionFacts: ExecutionFacts | undefined;
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
			...(input.executionFacts ?? {}),
			correlation: createTelemetryCorrelation({
				requestId: crypto.randomUUID(),
				traceId: crypto.randomUUID().replaceAll("-", ""),
			}),
			event: "mcp.request.completed",
			keyIdentifier: input.keyIdentifier,
			latencyMs: Math.max(0, Math.round(performance.now() - input.startedAt)),
			tool: input.tool,
		});
		await recordEvent(input.environment, event);
	} catch {
		// no-excuse-ok: catch telemetry failures must never alter a completed request.
	}
}

async function recordEvent(
	environment: TelemetryEnvironment,
	event: TelemetryEvent,
): Promise<void> {
	try {
		console.log(event);
	} catch {
		// no-excuse-ok: catch telemetry sink failures must never alter a completed request.
	}
	try {
		await environment.TELEMETRY_TRACES.fetch(
			new Request("https://telemetry.internal/mcp.request.completed", {
				body: JSON.stringify(event),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
		);
	} catch {
		// no-excuse-ok: catch telemetry sink failures must never alter a completed request.
	}
	try {
		const metric = toAnalyticsMetric(event);
		environment.TELEMETRY.writeDataPoint({
			blobs: [...metric.blobs],
			doubles: [...metric.doubles],
		});
	} catch {
		// no-excuse-ok: catch telemetry sink failures must never alter a completed request.
	}
}

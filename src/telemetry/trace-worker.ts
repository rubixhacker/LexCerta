import { tracing } from "cloudflare:workers";
import { type TelemetryEvent, createTelemetryEvent } from "./contract.js";
import { toTelemetrySpanAttributes } from "./span-attributes.js";

const TRACE_EVENT_PATH = "/mcp.request.completed";

const telemetryTraceWorker = {
	async fetch(request: Request): Promise<Response> {
		if (request.method !== "POST" || new URL(request.url).pathname !== TRACE_EVENT_PATH) {
			return new Response(null, { status: 404 });
		}
		const event = await parseTelemetryEvent(request);
		if (event === undefined) return new Response(null, { status: 400 });
		tracing.enterSpan(event.event, (span) => {
			const attributes = toTelemetrySpanAttributes(event);
			for (const [key, value] of Object.entries(attributes)) span.setAttribute(key, value);
			console.log(event.event, attributes);
		});
		return new Response(null, { status: 204 });
	},
} satisfies ExportedHandler;

async function parseTelemetryEvent(request: Request): Promise<TelemetryEvent | undefined> {
	try {
		return createTelemetryEvent(await request.json());
	} catch {
		// no-excuse-ok: catch strict boundary failures are intentionally rejected without logging content.
		return undefined;
	}
}

export default telemetryTraceWorker;

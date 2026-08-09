import { describe, expect, it } from "vitest";
import { createTelemetryCorrelation, createTelemetryEvent, toAnalyticsMetric } from "./contract.js";

const correlation = createTelemetryCorrelation({
	requestId: "2f1b5a06-b4d1-4f13-8e3f-98f7a2980d23",
	traceId: "0af7651916cd43dd8448eb211c80319c",
});
const approvedEvent = {
	cacheStatus: "hit",
	circuitStatus: "closed",
	correlation,
	errorCategory: "none",
	event: "mcp.request.completed",
	freshness: "fresh",
	keyIdentifier: "key-01",
	latencyMs: 42,
	outcome: "verified",
	responseBytes: 384,
	tool: "verify_quote",
	upstreamStatus: "success",
};
const prohibitedFields = [
	["citation", "347 U.S. 483"],
	["quote", "No state shall deprive any person of life, liberty, or property."],
	["opinion", "The Constitution preserves ordered liberty."],
	["apiKey", "lc_live_key_abcdefghijklmnopqrstuvwxyzABCDEFGHI"],
	["authorization", "Bearer lc_live_key_abcdefghijklmnopqrstuvwxyzABCDEFGHI"],
] as const;

describe("telemetry contract", () => {
	it("accepts only the approved structured request fields", () => {
		expect(createTelemetryEvent(approvedEvent)).toEqual(approvedEvent);
	});

	it("rejects every prohibited legal-content and credential field", () => {
		for (const [field, value] of prohibitedFields) {
			expect(() => createTelemetryEvent({ ...approvedEvent, [field]: value })).toThrow();
		}
	});

	it("projects only identifier-free aggregate dimensions into Analytics Engine", () => {
		const metric = toAnalyticsMetric(createTelemetryEvent(approvedEvent));

		expect(metric).toEqual({
			blobs: ["verify_quote", "verified", "hit", "fresh", "closed", "success", "none"],
			doubles: [42, 384, 1],
		});
		expect(JSON.stringify(metric)).not.toContain("key-01");
		expect(JSON.stringify(metric)).not.toContain(correlation.requestId);
		expect(JSON.stringify(metric)).not.toContain(correlation.traceId);
	});
});

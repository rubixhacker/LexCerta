import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("telemetry trace Worker", () => {
	it("records only strict contract attributes within its internal custom span", async () => {
		// Given: a service-bound completion event with a legal-content canary absent from its contract.
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

		// When: the internal trace Worker receives the trusted event transport request.
		const response = await SELF.fetch(
			new Request("https://telemetry.internal/mcp.request.completed", {
				body: JSON.stringify(validEvent()),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
		);

		// Then: the Worker accepts the event and logs only its allow-listed span attributes.
		expect(response.status).toBe(204);
		expect(log).toHaveBeenCalledWith(
			"mcp.request.completed",
			expect.objectContaining({
				"lexcerta.key_identifier": "key-01",
				"lexcerta.outcome": "verified",
				"lexcerta.tool": "verify_quote",
				"lexcerta.upstream_latency_ms": 27,
			}),
		);
		expect(JSON.stringify(log.mock.calls)).not.toContain("LEGAL_CONTENT_CANARY");
	});

	it("rejects an internal event carrying an unapproved canary field", async () => {
		// Given: a nominal telemetry event augmented with a field that no trace may persist.
		const unapproved = { ...validEvent(), citation: "LEGAL_CONTENT_CANARY" };

		// When: the isolated Worker parses the service-binding request at its boundary.
		const response = await SELF.fetch(
			new Request("https://telemetry.internal/mcp.request.completed", {
				body: JSON.stringify(unapproved),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
		);

		// Then: strict parsing rejects the entire event before it reaches the trace span.
		expect(response.status).toBe(400);
	});
});

function validEvent(): Readonly<Record<string, unknown>> {
	return {
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
	};
}

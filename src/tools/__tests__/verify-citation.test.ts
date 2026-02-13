import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import type {
	CitationMatch,
	CourtListenerClient,
	LookupResponse,
} from "../../clients/courtlistener.js";
import { registerVerifyCitationTool } from "../verify-citation.js";

/**
 * Capture the handler registered by registerVerifyCitationTool by mocking McpServer.
 * This lets us test the handler logic directly without a real MCP server.
 */
function captureHandler() {
	let capturedHandler: (args: { citation: string }) => Promise<unknown>;

	const mockServer = {
		registerTool: (
			_name: string,
			_schema: unknown,
			handler: (args: { citation: string }) => Promise<unknown>,
		) => {
			capturedHandler = handler;
		},
	} as unknown as McpServer;

	const mockClient = {
		lookupCitation: vi.fn<(citation: string) => Promise<LookupResponse>>(),
	} as unknown as CourtListenerClient;

	registerVerifyCitationTool(mockServer, mockClient);

	return {
		// biome-ignore lint/style/noNonNullAssertion: handler is set synchronously in registerTool
		handler: capturedHandler!,
		mockClient,
		lookupCitation: (mockClient as unknown as { lookupCitation: ReturnType<typeof vi.fn> })
			.lookupCitation,
	};
}

function parseEnvelope(result: unknown) {
	const content = (result as { content: Array<{ text: string }> }).content;
	return JSON.parse(content[0].text);
}

describe("verify_west_citation tool", () => {
	it("returns PARSE_ERROR for unparseable input without calling API", async () => {
		const { handler, lookupCitation } = captureHandler();

		const result = await handler({ citation: "not a citation" });
		const envelope = parseEnvelope(result);

		expect(envelope.valid).toBe(false);
		expect(envelope.error.code).toBe("PARSE_ERROR");
		expect(envelope.metadata).toBeNull();
		expect(lookupCitation).not.toHaveBeenCalled();
	});

	it("returns RATE_LIMITED when client is rate limited", async () => {
		const { handler, lookupCitation } = captureHandler();
		lookupCitation.mockResolvedValue({
			status: "rate_limited",
			retryAfterMs: 720,
		});

		const result = await handler({ citation: "347 U.S. 483" });
		const envelope = parseEnvelope(result);

		expect(envelope.valid).toBe(false);
		expect(envelope.error.code).toBe("RATE_LIMITED");
		expect(envelope.metadata.status).toBe("rate_limited");
		expect(envelope.error.details.retryAfterMs).toBe(720);
	});

	it("returns API_ERROR when CourtListener is down", async () => {
		const { handler, lookupCitation } = captureHandler();
		lookupCitation.mockResolvedValue({
			status: "error",
			code: "API_ERROR",
			message: "Service unavailable",
		});

		const result = await handler({ citation: "347 U.S. 483" });
		const envelope = parseEnvelope(result);

		expect(envelope.valid).toBe(false);
		expect(envelope.error.code).toBe("API_ERROR");
		expect(envelope.metadata.status).toBe("error");
		expect(envelope.error.message).toContain("NOT a citation verification failure");
	});

	it("returns HALLUCINATION_DETECTED when citation not found", async () => {
		const { handler, lookupCitation } = captureHandler();
		lookupCitation.mockResolvedValue({
			status: "ok",
			matches: [
				{
					citation: "999 U.S. 999",
					normalized_citations: [],
					start_index: 0,
					end_index: 12,
					status: 404,
					error_message: "Citation not found.",
					clusters: [],
				} satisfies CitationMatch,
			],
		});

		const result = await handler({ citation: "999 U.S. 999" });
		const envelope = parseEnvelope(result);

		expect(envelope.valid).toBe(false);
		expect(envelope.error.code).toBe("HALLUCINATION_DETECTED");
		expect(envelope.metadata.status).toBe("not_found");
		expect(envelope.error.message).toContain("not found in CourtListener database");
		expect(envelope.error.details.queriedCitation).toBe("999 U.S. 999");
	});

	it("returns verified with case metadata when citation found", async () => {
		const { handler, lookupCitation } = captureHandler();
		lookupCitation.mockResolvedValue({
			status: "ok",
			matches: [
				{
					citation: "347 U.S. 483",
					normalized_citations: ["347 U.S. 483"],
					start_index: 0,
					end_index: 12,
					status: 200,
					error_message: "",
					clusters: [
						{
							absolute_url: "/opinion/12345/brown-v-board/",
							case_name: "Brown v. Board of Education",
							case_name_short: "Brown",
							date_filed: "1954-05-17",
							docket: { court: "Supreme Court of the United States", court_id: "scotus" },
							citations: [{ volume: 347, reporter: "U.S.", page: "483" }],
						},
					],
				} satisfies CitationMatch,
			],
		});

		const result = await handler({ citation: "347 U.S. 483" });
		const envelope = parseEnvelope(result);

		expect(envelope.valid).toBe(true);
		expect(envelope.metadata.status).toBe("verified");
		expect(envelope.metadata.caseName).toBe("Brown v. Board of Education");
		expect(envelope.metadata.court).toBe("Supreme Court of the United States");
		expect(envelope.metadata.dateFiled).toBe("1954-05-17");
		expect(envelope.metadata.courtListenerUrl).toContain("/opinion/12345/brown-v-board/");
		expect(envelope.error).toBeNull();
	});

	it("returns HALLUCINATION_DETECTED when matches array is empty", async () => {
		const { handler, lookupCitation } = captureHandler();
		lookupCitation.mockResolvedValue({
			status: "ok",
			matches: [],
		});

		const result = await handler({ citation: "347 U.S. 483" });
		const envelope = parseEnvelope(result);

		expect(envelope.valid).toBe(false);
		expect(envelope.error.code).toBe("HALLUCINATION_DETECTED");
		expect(envelope.metadata.status).toBe("not_found");
	});
});

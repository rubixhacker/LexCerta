import { McpServer, createMcpHandler, preloadSchemas } from "@modelcontextprotocol/server";
import { registerParseCitationTool } from "./verification/citation.js";
import { registerVerificationTools } from "./verification/indeterminate.js";
import type { CitationVerificationGateway } from "./verification/verify-citation.js";
import type { QuoteVerificationGateway } from "./verification/verify-quote.js";

const PROTOCOL_VERSION = "2026-07-28";
const CACHE_TTL_MILLISECONDS = 5 * 60 * 1000;

preloadSchemas();

type VerificationGateways = {
	readonly citation: CitationVerificationGateway;
	readonly quote: QuoteVerificationGateway;
};

function createServer(gateways: VerificationGateways): McpServer {
	const server = new McpServer(
		{ name: "lexcerta", version: "1.0.0" },
		{
			capabilities: { tools: {} },
			instructions:
				"Use the read-only citation and quote evidence tools. Structured results are contract-versioned and source-scoped.",
			cacheHints: {
				"server/discover": {
					cacheScope: "public",
					ttlMs: CACHE_TTL_MILLISECONDS,
				},
				"tools/list": {
					cacheScope: "public",
					ttlMs: CACHE_TTL_MILLISECONDS,
				},
			},
			supportedProtocolVersions: [PROTOCOL_VERSION],
		},
	);
	registerParseCitationTool(server);
	registerVerificationTools(server, gateways.citation, gateways.quote);
	return server;
}

export function createLexCertaMcpHandler(gateways: VerificationGateways) {
	return createMcpHandler(() => createServer(gateways), { legacy: "reject", responseMode: "json" });
}

export function protocolBoundaryRejection(request: Request): Response | undefined {
	if (!request.headers.has("mcp-protocol-version")) {
		return new Response(null, { status: 400 });
	}
	if (request.headers.has("mcp-session-id")) {
		return new Response(null, { status: 400 });
	}
	if (request.headers.get("mcp-method") === "subscriptions/listen") {
		return new Response(null, { status: 400 });
	}
	return undefined;
}

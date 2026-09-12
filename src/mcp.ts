import {
	McpServer,
	classifyInboundRequest,
	createMcpHandler,
	isJsonContentType,
	preloadSchemas,
} from "@modelcontextprotocol/server";
import { registerParseCitationTool } from "./verification/citation.js";
import { registerVerificationTools } from "./verification/tools.js";
import type { CitationVerificationGateway } from "./verification/verify-citation.js";
import type { QuoteVerificationGateway, QuoteSearchOptions } from "./verification/verify-quote.js";

const PROTOCOL_VERSION = "2026-07-28";
const CACHE_TTL_MILLISECONDS = 5 * 60 * 1000;

preloadSchemas();

type VerificationGateways = Pick<QuoteSearchOptions, "request" | "normalize"> & {
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
	registerVerificationTools(server, gateways.citation, gateways.quote, gateways);
	return server;
}

export function createLexCertaMcpHandler(gateways: VerificationGateways) {
	return createMcpHandler(() => createServer(gateways), { legacy: "reject", responseMode: "json" });
}

// The caller has already bounded the body. Fill the pinned SDK's missing-header
// gap and exclude its built-in subscriptions router without reimplementing MCP.
export async function protocolBoundaryRejection(request: Request): Promise<Response | undefined> {
	if (request.headers.has("mcp-session-id")) {
		return new Response(null, { status: 400, headers: { "cache-control": "no-store" } });
	}
	if (
		(request.headers.has("mcp-protocol-version") &&
			request.headers.get("mcp-method")?.trim() !== "subscriptions/listen") ||
		!isJsonContentType(request.headers.get("content-type"))
	) {
		return undefined;
	}
	let body: unknown;
	try {
		body = await request.clone().json();
	} catch {
		// no-excuse-ok: catch
		return undefined;
	}
	const route = classifyInboundRequest({
		httpMethod: request.method,
		...optionalHeader(request, "mcp-protocol-version", "protocolVersionHeader"),
		...optionalHeader(request, "mcp-method", "mcpMethodHeader"),
		...optionalHeader(request, "mcp-name", "mcpNameHeader"),
		body,
	});
	if (
		route.kind === "modern" &&
		route.messageKind === "request" &&
		!request.headers.has("mcp-protocol-version")
	) {
		return Response.json(
			{
				jsonrpc: "2.0",
				id: route.message.id,
				error: { code: -32020, message: "MCP-Protocol-Version header is required" },
			},
			{ status: 400, headers: { "cache-control": "no-store" } },
		);
	}
	if (
		route.kind === "modern" &&
		route.messageKind === "request" &&
		route.classification.revision === PROTOCOL_VERSION &&
		route.message.method === "subscriptions/listen"
	) {
		// JSON response mode does not disable the SDK's built-in subscription router.
		return Response.json(
			{
				jsonrpc: "2.0",
				id: route.message.id,
				error: { code: -32601, message: "Method not found" },
			},
			{ status: 404, headers: { "cache-control": "no-store" } },
		);
	}
	return undefined;
}

function optionalHeader<Key extends string>(request: Request, header: string, key: Key) {
	const value = request.headers.get(header);
	return value === null ? {} : { [key]: value };
}

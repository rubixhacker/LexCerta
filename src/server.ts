import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CitationCache } from "./cache/citation-cache";
import { OpinionCache } from "./cache/opinion-cache";
import { CourtListenerClient } from "./clients/courtlistener";
import type { Config } from "./config";
import { logger } from "./logger";
import { courtListenerPolicy } from "./resilience/circuit-breaker";
import { TokenBucketRateLimiter } from "./resilience/rate-limiter";
import { registerEchoTool } from "./tools/echo";
import { registerParseCitationTool } from "./tools/parse-citation";
import { registerVerifyCitationTool } from "./tools/verify-citation";
import { registerVerifyQuoteTool } from "./tools/verify-quote";

/**
 * Module-level singleton client. Persists across stateless transport requests
 * so rate limiter and circuit breaker state is shared (Pitfall 2 from research).
 */
let sharedClient: CourtListenerClient | null = null;
let sharedCache: CitationCache | null = null;
let sharedOpinionCache: OpinionCache | null = null;

function getClient(config: Config): CourtListenerClient {
	if (!sharedClient) {
		const rateLimiter = new TokenBucketRateLimiter();
		sharedClient = new CourtListenerClient(
			config.COURTLISTENER_API_KEY,
			courtListenerPolicy,
			rateLimiter,
		);
	}
	return sharedClient;
}

function getCache(): CitationCache {
	if (!sharedCache) {
		sharedCache = new CitationCache();
	}
	return sharedCache;
}

function getOpinionCache(): OpinionCache {
	if (!sharedOpinionCache) {
		sharedOpinionCache = new OpinionCache();
	}
	return sharedOpinionCache;
}

/** Reset singleton client and cache (for testing). */
export function resetClient(): void {
	sharedClient = null;
	sharedCache = null;
	sharedOpinionCache = null;
}

/**
 * Register all LexCerta tools on the given MCP server.
 * Used by both the local dev entry point (createServer) and the Vercel
 * entry point (api/server.ts via mcp-handler).
 */
export function registerTools(server: McpServer, config: Config): void {
	const client = getClient(config);
	const cache = getCache();
	const opinionCache = getOpinionCache();

	registerEchoTool(server);
	registerParseCitationTool(server);
	registerVerifyCitationTool(server, client, cache);
	registerVerifyQuoteTool(server, client, cache, opinionCache);
	logger.debug(
		"Registered tools: echo, parse_citation, verify_west_citation, verify_quote_integrity",
	);
}

export function createServer(config: Config): McpServer {
	const server = new McpServer(
		{ name: "lexcerta", version: "0.1.0" },
		{ capabilities: { logging: {} } },
	);

	registerTools(server, config);

	return server;
}

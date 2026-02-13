import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CitationCache } from "./cache/citation-cache.js";
import { CourtListenerClient } from "./clients/courtlistener.js";
import type { Config } from "./config.js";
import { logger } from "./logger.js";
import { courtListenerPolicy } from "./resilience/circuit-breaker.js";
import { TokenBucketRateLimiter } from "./resilience/rate-limiter.js";
import { registerEchoTool } from "./tools/echo.js";
import { registerParseCitationTool } from "./tools/parse-citation.js";
import { registerVerifyCitationTool } from "./tools/verify-citation.js";

/**
 * Module-level singleton client. Persists across stateless transport requests
 * so rate limiter and circuit breaker state is shared (Pitfall 2 from research).
 */
let sharedClient: CourtListenerClient | null = null;
let sharedCache: CitationCache | null = null;

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

/** Reset singleton client and cache (for testing). */
export function resetClient(): void {
	sharedClient = null;
	sharedCache = null;
}

export function createServer(config: Config): McpServer {
	const server = new McpServer(
		{ name: "lexcerta", version: "0.1.0" },
		{ capabilities: { logging: {} } },
	);

	const client = getClient(config);
	const cache = getCache();

	registerEchoTool(server);
	registerParseCitationTool(server);
	registerVerifyCitationTool(server, client, cache);
	logger.debug("Registered tools: echo, parse_citation, verify_west_citation");

	return server;
}

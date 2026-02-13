import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logger } from "./logger.js";
import { registerEchoTool } from "./tools/echo.js";
import { registerParseCitationTool } from "./tools/parse-citation.js";

export function createServer(): McpServer {
	const server = new McpServer(
		{ name: "lexcerta", version: "0.1.0" },
		{ capabilities: { logging: {} } },
	);

	registerEchoTool(server);
	registerParseCitationTool(server);
	logger.debug("Registered tools: echo, parse_citation");

	return server;
}

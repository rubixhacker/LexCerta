import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logger } from "./logger.js";
import { registerEchoTool } from "./tools/echo.js";

export function createServer(): McpServer {
	const server = new McpServer(
		{ name: "lexcerta", version: "0.1.0" },
		{ capabilities: { logging: {} } },
	);

	registerEchoTool(server);
	logger.debug("Registered tools: echo");

	return server;
}

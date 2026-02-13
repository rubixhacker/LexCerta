import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { logger } from "../logger.js";
import { createToolResponse } from "../types.js";

export function registerEchoTool(server: McpServer): void {
	server.registerTool(
		"echo",
		{
			description: "Echo input back in the standard response envelope (test tool)",
			inputSchema: {
				message: z.string().min(1).describe("Message to echo back"),
			},
		},
		async ({ message }) => {
			logger.debug("Echo tool called with:", message);
			return createToolResponse({
				valid: true,
				metadata: { echo: message },
				error: null,
			});
		},
	);
}

import { createMcpHandler } from "mcp-handler";
import { loadConfig } from "../src/config.js";
import { registerTools } from "../src/server.js";

const handler = createMcpHandler(
	(server) => {
		const config = loadConfig();
		registerTools(server, config);
	},
	{
		serverInfo: { name: "lexcerta", version: "0.1.0" },
		capabilities: { logging: {} },
	},
	{
		basePath: "/api",
		maxDuration: 60,
	},
);

export { handler as GET, handler as POST, handler as DELETE };

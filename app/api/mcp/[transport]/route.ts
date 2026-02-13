import { loadConfig } from "@/config";
import { registerTools } from "@/server";
import { createMcpHandler } from "mcp-handler";

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
		basePath: "/api/mcp",
		maxDuration: 60,
		verboseLogs: true,
	},
);

export { handler as GET, handler as POST, handler as DELETE };

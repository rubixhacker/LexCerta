import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Request, type Response } from "express";
import { logger } from "./logger.js";
import { createServer } from "./server.js";

export function createApp() {
	const app = express();
	app.use(express.json());

	app.post("/mcp", async (req: Request, res: Response) => {
		const server = createServer();
		try {
			const transport = new StreamableHTTPServerTransport({
				sessionIdGenerator: undefined,
			});
			await server.connect(transport);
			await transport.handleRequest(req, res, req.body);
			res.on("close", () => {
				transport.close();
				server.close();
			});
		} catch (error) {
			logger.error("MCP request error:", error);
			if (!res.headersSent) {
				res.status(500).json({
					jsonrpc: "2.0",
					error: { code: -32603, message: "Internal server error" },
					id: null,
				});
			}
		}
	});

	app.get("/mcp", (_req: Request, res: Response) => {
		res.writeHead(405).end(
			JSON.stringify({
				jsonrpc: "2.0",
				error: { code: -32000, message: "Method not allowed." },
				id: null,
			}),
		);
	});

	app.delete("/mcp", (_req: Request, res: Response) => {
		res.writeHead(405).end(
			JSON.stringify({
				jsonrpc: "2.0",
				error: { code: -32000, message: "Method not allowed." },
				id: null,
			}),
		);
	});

	app.get("/health", (_req: Request, res: Response) => {
		res.status(200).json({ status: "ok" });
	});

	return app;
}

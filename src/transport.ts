import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Request, type Response } from "express";
import type { Config } from "./config";
import { loadConfig } from "./config";
import { logger } from "./logger";
import { createServer } from "./server";

const sseTransports = new Map<string, SSEServerTransport>();

export function createApp(config?: Config) {
	const resolvedConfig = config ?? loadConfig();
	const app = express();
	app.use(express.json());

	// --- Streamable HTTP (primary transport) ---

	app.post("/mcp", async (req: Request, res: Response) => {
		const server = createServer(resolvedConfig);
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

	// --- SSE fallback (legacy transport) ---

	app.get("/sse", async (_req: Request, res: Response) => {
		const server = createServer(resolvedConfig);
		try {
			const transport = new SSEServerTransport("/messages", res);
			sseTransports.set(transport.sessionId, transport);
			logger.info("SSE client connected, sessionId:", transport.sessionId);

			res.on("close", () => {
				sseTransports.delete(transport.sessionId);
				server.close();
				logger.info("SSE client disconnected, sessionId:", transport.sessionId);
			});

			await server.connect(transport);
		} catch (error) {
			logger.error("SSE connection error:", error);
			if (!res.headersSent) {
				res.status(500).end();
			}
		}
	});

	app.post("/messages", async (req: Request, res: Response) => {
		const sessionId = req.query.sessionId as string;
		const transport = sseTransports.get(sessionId);

		if (!transport) {
			res.status(400).json({ error: "Unknown or expired session" });
			return;
		}

		try {
			await transport.handlePostMessage(req, res, req.body);
		} catch (error) {
			logger.error("SSE message error:", error);
			if (!res.headersSent) {
				res.status(500).json({ error: "Internal server error" });
			}
		}
	});

	// --- Health check ---

	app.get("/health", (_req: Request, res: Response) => {
		res.status(200).json({ status: "ok" });
	});

	return app;
}

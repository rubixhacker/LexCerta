import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetClient } from "../server";
import { createApp } from "../transport";

let server: Server;
let baseUrl: string;

const mcpHeaders = {
	"Content-Type": "application/json",
	Accept: "application/json, text/event-stream",
};

beforeAll(async () => {
	process.env.COURTLISTENER_API_KEY = "test-key";
	const app = createApp();
	await new Promise<void>((resolve) => {
		server = app.listen(0, () => {
			const addr = server.address();
			if (addr && typeof addr === "object") {
				baseUrl = `http://localhost:${addr.port}`;
			}
			resolve();
		});
	});
});

afterAll(async () => {
	resetClient();
	await new Promise<void>((resolve) => {
		server.close(() => resolve());
	});
});

function jsonRpc(method: string, params: unknown, id: number) {
	return { jsonrpc: "2.0", method, params, id };
}

/**
 * Parse SSE response body and extract JSON-RPC messages from `event: message` lines.
 * The SDK returns SSE format for Streamable HTTP POST responses.
 */
async function parseSseResponse(res: Response): Promise<unknown[]> {
	const text = await res.text();
	const messages: unknown[] = [];
	const lines = text.split("\n");
	for (const line of lines) {
		if (line.startsWith("data: ")) {
			messages.push(JSON.parse(line.slice(6)));
		}
	}
	return messages;
}

async function mcpPost(body: unknown): Promise<{ status: number; messages: unknown[] }> {
	const res = await fetch(`${baseUrl}/mcp`, {
		method: "POST",
		headers: mcpHeaders,
		body: JSON.stringify(body),
	});
	if (res.status !== 200) {
		return { status: res.status, messages: [] };
	}
	const messages = await parseSseResponse(res);
	return { status: res.status, messages };
}

const initializeRequest = jsonRpc(
	"initialize",
	{
		protocolVersion: "2025-03-26",
		capabilities: {},
		clientInfo: { name: "test-client", version: "1.0" },
	},
	1,
);

describe("Streamable HTTP (Success Criterion 1)", () => {
	it("POST /mcp with initialize returns capabilities", async () => {
		const { status, messages } = await mcpPost(initializeRequest);
		expect(status).toBe(200);
		expect(messages).toHaveLength(1);
		const body = messages[0] as Record<string, unknown>;
		expect(body.result).toBeDefined();
		const result = body.result as Record<string, unknown>;
		expect((result.serverInfo as Record<string, unknown>).name).toBe("lexcerta");
		expect(result.capabilities).toBeDefined();
	});

	it("POST /mcp with echo tool returns envelope response", async () => {
		const toolCall = jsonRpc("tools/call", { name: "echo", arguments: { message: "hello" } }, 2);
		const { status, messages } = await mcpPost(toolCall);
		expect(status).toBe(200);
		expect(messages.length).toBeGreaterThanOrEqual(1);

		const body = messages[0] as Record<string, unknown>;
		expect(body.result).toBeDefined();
		const result = body.result as Record<string, unknown>;
		const content = result.content as Array<Record<string, string>>;
		expect(content).toBeInstanceOf(Array);

		const envelope = JSON.parse(content[0].text);
		expect(envelope.valid).toBe(true);
		expect(envelope.metadata.echo).toBe("hello");
	});

	it("GET /mcp returns 405", async () => {
		const res = await fetch(`${baseUrl}/mcp`);
		expect(res.status).toBe(405);
	});

	it("DELETE /mcp returns 405", async () => {
		const res = await fetch(`${baseUrl}/mcp`, { method: "DELETE" });
		expect(res.status).toBe(405);
	});
});

describe("Input validation (Success Criterion 3)", () => {
	it("echo tool with empty message returns validation error", async () => {
		const toolCall = jsonRpc("tools/call", { name: "echo", arguments: { message: "" } }, 3);
		const { status, messages } = await mcpPost(toolCall);
		expect(status).toBe(200);

		const body = messages[0] as Record<string, unknown>;
		// Zod validation error surfaces as JSON-RPC error or isError flag
		const hasError =
			body.error !== undefined || (body.result as Record<string, unknown>)?.isError === true;
		expect(hasError).toBe(true);
	});

	it("echo tool with missing message field returns error", async () => {
		const toolCall = jsonRpc("tools/call", { name: "echo", arguments: {} }, 4);
		const { status, messages } = await mcpPost(toolCall);
		expect(status).toBe(200);

		const body = messages[0] as Record<string, unknown>;
		const hasError =
			body.error !== undefined || (body.result as Record<string, unknown>)?.isError === true;
		expect(hasError).toBe(true);
	});

	it("echo tool with valid message returns success envelope", async () => {
		const toolCall = jsonRpc(
			"tools/call",
			{ name: "echo", arguments: { message: "valid test" } },
			5,
		);
		const { status, messages } = await mcpPost(toolCall);
		expect(status).toBe(200);

		const body = messages[0] as Record<string, unknown>;
		expect(body.result).toBeDefined();
		const result = body.result as Record<string, unknown>;
		const content = result.content as Array<Record<string, string>>;
		const envelope = JSON.parse(content[0].text);
		expect(envelope.valid).toBe(true);
	});
});

describe("SSE fallback (Success Criterion 2)", () => {
	it("GET /sse returns 200 with text/event-stream content type", async () => {
		const controller = new AbortController();
		const res = await fetch(`${baseUrl}/sse`, {
			signal: controller.signal,
		});

		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/event-stream");

		// Read the first chunk to verify endpoint event
		// biome-ignore lint/style/noNonNullAssertion: body is guaranteed present after successful SSE response
		const reader = res.body!.getReader();
		const { value } = await reader.read();
		const text = new TextDecoder().decode(value);
		expect(text).toContain("event: endpoint");
		expect(text).toContain("/messages?sessionId=");

		controller.abort();
	});

	it("POST /messages with invalid sessionId returns 400", async () => {
		const res = await fetch(`${baseUrl}/messages?sessionId=nonexistent`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toContain("Unknown or expired session");
	});
});

import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../transport.js";

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
	await new Promise<void>((resolve) => {
		server.close(() => resolve());
	});
});

function jsonRpc(method: string, params: unknown, id: number) {
	return { jsonrpc: "2.0", method, params, id };
}

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

describe("parse_citation MCP tool", () => {
	it("returns structured result for valid citation '347 U.S. 483'", async () => {
		const toolCall = jsonRpc(
			"tools/call",
			{ name: "parse_citation", arguments: { citation: "347 U.S. 483" } },
			1,
		);
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
		expect(envelope.metadata).toEqual({
			volume: 347,
			reporter: "U.S.",
			page: 483,
			normalized: "347 U.S. 483",
		});
		expect(envelope.error).toBeNull();
	});

	it("returns error envelope for invalid citation 'not a citation'", async () => {
		const toolCall = jsonRpc(
			"tools/call",
			{ name: "parse_citation", arguments: { citation: "not a citation" } },
			2,
		);
		const { status, messages } = await mcpPost(toolCall);
		expect(status).toBe(200);
		expect(messages.length).toBeGreaterThanOrEqual(1);

		const body = messages[0] as Record<string, unknown>;
		expect(body.result).toBeDefined();
		const result = body.result as Record<string, unknown>;
		const content = result.content as Array<Record<string, string>>;
		const envelope = JSON.parse(content[0].text);
		expect(envelope.valid).toBe(false);
		expect(envelope.metadata).toBeNull();
		expect(envelope.error.code).toBe("PARSE_ERROR");
		expect(envelope.error.message).toContain("Could not parse");
	});

	it("rejects empty string input via Zod validation", async () => {
		const toolCall = jsonRpc(
			"tools/call",
			{ name: "parse_citation", arguments: { citation: "" } },
			3,
		);
		const { status, messages } = await mcpPost(toolCall);
		expect(status).toBe(200);

		const body = messages[0] as Record<string, unknown>;
		// Zod .min(1) validation error surfaces as JSON-RPC error or isError flag
		const hasError =
			body.error !== undefined || (body.result as Record<string, unknown>)?.isError === true;
		expect(hasError).toBe(true);
	});
});

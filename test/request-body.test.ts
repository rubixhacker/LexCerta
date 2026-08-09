import { describe, expect, it } from "vitest";
import { MAX_MCP_REQUEST_BODY_BYTES, boundedMcpRequest } from "../src/request-body.js";

const encoder = new TextEncoder();

function streamed(bytes: Uint8Array, contentLength?: string) {
	let cancelled = false;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes.slice(0, 32));
			controller.enqueue(bytes.slice(32));
		},
		cancel() {
			cancelled = true;
		},
	});
	return {
		request: new Request("https://mcp.lexcerta.ai/", {
			method: "POST",
			headers: contentLength === undefined ? {} : { "content-length": contentLength },
			body: stream,
		}),
		wasCancelled: () => cancelled,
	};
}

describe("MCP request body cap", () => {
	it("rebuilds an equivalent bounded request for downstream MCP parsing", async () => {
		// Given: a small modern MCP JSON request with routing and custom headers.
		const request = new Request("https://mcp.lexcerta.ai/?fixture=1", {
			method: "POST",
			headers: { "content-type": "application/json", "x-fixture": "preserved" },
			body: '{"jsonrpc":"2.0"}',
		});

		// When: the Worker enforces the request byte cap before SDK dispatch.
		const bounded = await boundedMcpRequest(request);

		// Then: downstream receives an equivalent readable request rather than a consumed stream.
		expect(bounded).toBeInstanceOf(Request);
		if (bounded === undefined) throw new Error("Expected bounded request.");
		expect(bounded.url).toBe(request.url);
		expect(bounded.method).toBe("POST");
		expect(bounded.headers.get("content-type")).toBe("application/json");
		expect(bounded.headers.get("x-fixture")).toBe("preserved");
		expect(await bounded.text()).toBe('{"jsonrpc":"2.0"}');
	});

	it("cancels a declared oversized request body without reading it", async () => {
		// Given: a small stream that dishonestly declares a body beyond the hard cap.
		const source = streamed(encoder.encode("{}"), String(MAX_MCP_REQUEST_BODY_BYTES + 1));

		// When: the Worker evaluates the declared Content-Length.
		const bounded = await boundedMcpRequest(source.request);

		// Then: it rejects and cancels the unread stream before downstream parsing.
		expect(bounded).toBeUndefined();
		expect(source.wasCancelled()).toBe(true);
	});

	it("cancels an undeclared streamed body that crosses the byte cap", async () => {
		// Given: a stream whose real content exceeds the cap without a declaration.
		const source = streamed(encoder.encode("x".repeat(MAX_MCP_REQUEST_BODY_BYTES + 1)));

		// When: the Worker buffers the body defensively.
		const bounded = await boundedMcpRequest(source.request);

		// Then: it rejects and cancels after the cap boundary rather than forwarding it.
		expect(bounded).toBeUndefined();
		expect(source.wasCancelled()).toBe(true);
	});

	it("cancels a lying-length streamed body that crosses the byte cap", async () => {
		// Given: a stream whose real content exceeds the cap despite a short declaration.
		const source = streamed(encoder.encode("x".repeat(MAX_MCP_REQUEST_BODY_BYTES + 1)), "1");

		// When: the Worker buffers the body defensively.
		const bounded = await boundedMcpRequest(source.request);

		// Then: it rejects and cancels after the cap boundary rather than forwarding it.
		expect(bounded).toBeUndefined();
		expect(source.wasCancelled()).toBe(true);
	});
});

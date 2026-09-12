import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connectPilot, runPilot } from "../examples/pilot-client.ts";
import { QUOTE, TOKEN } from "./worker-bundle-conformance-fixtures.mjs";

// A loopback-only bridge to the emitted product bundle. All upstream traffic stays
// behind that bundle's fixture trap; the Node SDK itself makes real HTTP requests.
export async function qualifyPilotClient(miniflare) {
	const frames = [];
	const bridge = createServer(async (incoming, outgoing) => {
		try {
			if (incoming.headers.host !== `127.0.0.1:${bridge.address().port}`) {
				outgoing.writeHead(403).end();
				return;
			}
			const chunks = [];
			let bytes = 0;
			for await (const chunk of incoming) {
				bytes += chunk.length;
				if (bytes > 65_536) {
					outgoing.writeHead(413).end();
					return;
				}
				chunks.push(chunk);
			}
			const headers = new Headers();
			for (const [name, value] of Object.entries(incoming.headers)) {
				if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
			}
			const response = await miniflare.dispatchFetch(`https://mcp.bundle.test${incoming.url}`, {
				method: incoming.method,
				headers,
				...(incoming.method === "POST" ? { body: Buffer.concat(chunks) } : {}),
			});
			outgoing.writeHead(response.status, Object.fromEntries(response.headers));
			outgoing.end(Buffer.from(await response.arrayBuffer()));
		} catch {
			outgoing.writeHead(502).end();
		}
	});
	await new Promise((resolve, reject) => {
		bridge.once("error", reject);
		bridge.listen(0, "127.0.0.1", resolve);
	});
	let client;
	try {
		client = await connectPilot(
			new URL(`http://127.0.0.1:${bridge.address().port}/`),
			TOKEN,
			async (input, init) => {
				const request = new Request(input, init);
				const body = await request.clone().json();
				const response = await fetch(request);
				const result = await response.clone().json();
				frames.push({
					request: {
						method: request.method,
						headers: wireHeaders(request.headers),
						body: {
							...body,
							params: {
								...body.params,
								...(body.params?.arguments ? { arguments: "[redacted]" } : {}),
							},
						},
					},
					response: {
						status: response.status,
						headers: wireHeaders(response.headers),
						body: {
							...result,
							...(result.result
								? {
										result: {
											...result.result,
											...(result.result.content ? { content: "[redacted]" } : {}),
											...(result.result.structuredContent
												? {
														structuredContent: {
															contractVersion: result.result.structuredContent.contractVersion,
															outcome: result.result.structuredContent.outcome,
														},
													}
												: {}),
										},
									}
								: {}),
						},
					},
				});
				return response;
			},
		);
		const result = await runPilot(client, "347 U.S. 483", QUOTE);
		assert.equal(result.parsed.structuredContent.outcome, "parsed");
		assert.equal(result.citation.structuredContent.outcome, "verified");
		assert.equal(result.quote.structuredContent.outcome, "verified");
		assert.deepEqual(
			frames.map((frame) => frame.request.body.method),
			["server/discover", "tools/list", "tools/call", "tools/call", "tools/call"],
		);
		for (const frame of frames) {
			assert.equal(frame.request.method, "POST");
			assert.equal(frame.request.headers["mcp-protocol-version"], "2026-07-28");
			assert.equal(frame.request.headers["mcp-session-id"], undefined);
			assert.equal(frame.response.status, 200);
			assert.equal(frame.response.body.result.resultType, "complete");
		}
		assert.ok(!JSON.stringify(frames).includes(TOKEN));
		assert.ok(!JSON.stringify(frames).includes(QUOTE));
		return {
			runtime: process.version,
			client: "@modelcontextprotocol/client@2.0.0",
			transport: "Node HTTP over loopback to the emitted Worker bundle",
			frames,
		};
	} finally {
		await client?.close();
		await new Promise((resolve) => bridge.close(resolve));
	}
}

function wireHeaders(headers) {
	return Object.fromEntries(
		["accept", "content-type", "mcp-protocol-version", "mcp-method", "mcp-name", "mcp-session-id"]
			.filter((name) => headers.has(name))
			.map((name) => [name, headers.get(name)]),
	);
}

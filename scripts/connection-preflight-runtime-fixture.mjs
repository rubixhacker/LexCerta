import { createServer } from "node:http";
import { createLexCertaMcpHandler } from "../src/mcp.ts";

const forbiddenGateway = new Proxy(
	{},
	{
		get() {
			throw new Error("Preflight must not request evidence-source data");
		},
	},
);
const handler = createLexCertaMcpHandler({ citation: forbiddenGateway, quote: forbiddenGateway });
const server = createServer(async (incoming, outgoing) => {
	if (incoming.headers.authorization !== "Bearer fixture-preflight-token") {
		outgoing.writeHead(401);
		outgoing.end();
		return;
	}
	const chunks = [];
	for await (const chunk of incoming) chunks.push(chunk);
	const response = await handler.fetch(
		new Request(`http://127.0.0.1${incoming.url}`, {
			method: incoming.method,
			headers: incoming.headers,
			body: Buffer.concat(chunks),
		}),
	);
	outgoing.writeHead(response.status, Object.fromEntries(response.headers));
	outgoing.end(Buffer.from(await response.arrayBuffer()));
});
server.listen(0, "127.0.0.1", () => {
	const address = server.address();
	if (address && typeof address !== "string") {
		process.stdout.write(`http://127.0.0.1:${address.port}/mcp\n`);
	}
});

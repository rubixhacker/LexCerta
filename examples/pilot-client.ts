import {
	Client,
	StreamableHTTPClientTransport,
	type FetchLike,
} from "@modelcontextprotocol/client";

export async function connectPilot(
	endpoint: URL,
	apiKey: string,
	fetch?: FetchLike,
): Promise<Client> {
	if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
		throw new Error("Use an endpoint without credentials, query parameters, or a fragment");
	}
	if (
		endpoint.protocol !== "https:" &&
		!(
			endpoint.protocol === "http:" &&
			["127.0.0.1", "[::1]", "localhost"].includes(endpoint.hostname)
		)
	) {
		throw new Error("Use HTTPS, or HTTP on loopback for local qualification");
	}
	if (!apiKey.trim()) throw new Error("LEXCERTA_API_KEY is required");
	const client = new Client(
		{ name: "lexcerta-pilot", version: "0.1.0" },
		{ versionNegotiation: { mode: { pin: "2026-07-28" } } },
	);
	try {
		await client.connect(
			new StreamableHTTPClientTransport(endpoint, {
				authProvider: { token: async () => apiKey },
				requestInit: { redirect: "manual" },
				...(fetch === undefined ? {} : { fetch }),
			}),
		);
		return client;
	} catch (error) {
		await client.close();
		throw error;
	}
}

export async function runPilot(client: Client, citation: string, quote: string) {
	return {
		discovery: client.getDiscoverResult(),
		tools: await client.listTools(),
		parsed: await client.callTool({ name: "parse_citation", arguments: { citation } }),
		citation: await client.callTool({ name: "verify_citation", arguments: { citation } }),
		quote: await client.callTool({ name: "verify_quote", arguments: { citation, quote } }),
	};
}

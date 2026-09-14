import { pathToFileURL } from "node:url";
import { z } from "zod";
import { optionsSchema, requestJson } from "./connection-preflight-http.mjs";

const PROTOCOL_VERSION = "2026-07-28";
const parseResultSchema = z
	.object({
		jsonrpc: z.literal("2.0"),
		id: z.literal(2),
		result: z.object({
			isError: z.literal(false).optional(),
			content: z.array(z.object({ type: z.literal("text"), text: z.string() }).strict()),
			structuredContent: z
				.object({
					outcome: z.literal("parsed"),
					contractVersion: z.literal("1"),
					citation: z
						.object({
							volume: z.literal(347),
							reporter: z.literal("U.S."),
							page: z.literal(483),
							normalized: z.literal("347 U.S. 483"),
							suffix: z.literal(""),
						})
						.strict(),
				})
				.strict(),
		}),
	})
	.strict();

function rpc(method, id, token, params = {}) {
	return {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json",
			"mcp-protocol-version": PROTOCOL_VERSION,
			"mcp-method": method,
			...(method === "tools/call" ? { "mcp-name": "parse_citation" } : {}),
			...(token ? { authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id,
			method,
			params: {
				...params,
				_meta: {
					"io.modelcontextprotocol/clientCapabilities": {},
					"io.modelcontextprotocol/clientInfo": { name: "lexcerta-preflight", version: "1.0.0" },
					"io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
				},
			},
		}),
	};
}

function fact(response, status) {
	return {
		status,
		...(response.httpStatus === undefined ? {} : { httpStatus: response.httpStatus }),
	};
}

async function metadataCheck(challenge, options) {
	const match =
		/^Bearer\s+resource_metadata="([^"\r\n]+)"(?:\s*,\s*(?:scope|error|error_description)="[^"\r\n]*")*\s*$/i.exec(
			challenge ?? "",
		);
	if (!match) return { status: "not_advertised" };
	let url;
	try {
		url = new URL(match[1]);
	} catch (error) {
		if (!(error instanceof TypeError)) throw error;
		return { status: "invalid_metadata_url" };
	}
	if (url.username || url.password || url.search || url.hash)
		return { status: "invalid_metadata_url" };
	if (url.origin !== new URL(options.endpoint).origin) return { status: "cross_origin_not_tested" };
	const response = await requestJson(
		url,
		{ headers: { accept: "application/json" } },
		options.timeoutMs,
	);
	if (response.status !== "received") return fact(response, response.status);
	const metadata = z
		.object({
			resource: z.literal(options.endpoint),
			authorization_servers: z
				.array(
					z.url().refine((value) => {
						const issuer = new URL(value);
						return (
							issuer.protocol === "https:" &&
							!issuer.username &&
							!issuer.password &&
							!issuer.search &&
							!issuer.hash
						);
					}),
				)
				.min(1),
		})
		.safeParse(response.body);
	return fact(response, metadata.success ? "passed" : "invalid_metadata");
}

export async function runPreflight(input) {
	const options = optionsSchema.parse(input);
	const anonymous = await requestJson(options.endpoint, rpc("tools/list", 1), options.timeoutMs);
	const unauthenticated = fact(
		anonymous,
		anonymous.httpStatus === 401
			? "passed"
			: anonymous.status === "received"
				? "unexpected_access"
				: anonymous.status,
	);
	const oauthMetadata =
		anonymous.httpStatus === 401
			? await metadataCheck(anonymous.challenge, options)
			: { status: "not_tested" };
	const parsing = await requestJson(
		options.endpoint,
		rpc("tools/call", 2, options.token, {
			name: "parse_citation",
			arguments: { citation: "347 U.S. 483" },
		}),
		options.timeoutMs,
	);
	const statelessParsing = fact(
		parsing,
		parsing.status === "received"
			? parseResultSchema.safeParse(parsing.body).success
				? "passed"
				: "invalid_tool_result"
			: parsing.status,
	);
	const checks = { unauthenticated, oauthMetadata, statelessParsing };
	return {
		schemaVersion: 1,
		observedAt: new Date().toISOString(),
		protocolVersion: PROTOCOL_VERSION,
		passed: Object.values(checks).every((check) => check.status === "passed"),
		hostQualification: "not_tested",
		oauthAuthorizationFlow: "not_tested",
		checks,
	};
}

async function main() {
	const parsed = optionsSchema.safeParse({
		endpoint: process.env.LEXCERTA_PREFLIGHT_ENDPOINT,
		token: process.env.LEXCERTA_PREFLIGHT_TOKEN,
	});
	if (!parsed.success || process.argv.length !== 2) {
		process.stderr.write(
			"Set LEXCERTA_PREFLIGHT_ENDPOINT (HTTPS or loopback HTTP; no URL credentials, query, or fragment) and LEXCERTA_PREFLIGHT_TOKEN. No arguments accepted.\n",
		);
		process.exitCode = 2;
		return;
	}
	const report = await runPreflight(parsed.data);
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	process.exitCode = report.passed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await main();
}

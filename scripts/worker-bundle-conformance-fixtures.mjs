import { createHmac } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const CLUSTER_ID = 108713;
const OPINION_ID = 91001;
export const PROTOCOL_VERSION = "2026-07-28";
export const QUOTE = "q".repeat(10_000);
export const TOKEN = `lc_test_bundle_${"A".repeat(43)}`;
const PEPPER = "bundle-conformance-pepper";
export const FIXTURE_SOURCE_TEXT = "bundle fixture source text";
export const EXPECTED_URLS = [
	"https://www.courtlistener.com/api/rest/v4/api-usage/",
	"https://www.courtlistener.com/api/rest/v4/citation-lookup/",
	`https://www.courtlistener.com/api/rest/v4/clusters/${CLUSTER_ID}/`,
	`https://www.courtlistener.com/api/rest/v4/opinions/${OPINION_ID}/`,
];

export function workerUnderTest(input) {
	return {
		bindings: {
			API_KEY_PEPPER: PEPPER,
			BUILD_ID: "bundle-conformance",
			COURTLISTENER_API_TOKEN: "fixture-token-not-recorded",
			COURTLISTENER_CREDENTIAL_ID: "bundle-coordinator",
			KEY_ENVIRONMENT: "test",
		},
		compatibilityDate: input.compatibilityDate,
		d1Databases: { DB: "bundle-conformance" },
		durableObjects: {
			API_KEY_LIMITER: { className: "ApiKeyLimiter", useSQLite: true },
			COURTLISTENER_COORDINATOR: { className: "CourtListenerCoordinator", useSQLite: true },
		},
		modules: true,
		modulesRoot: input.root,
		name: "lexcerta-bundle",
		outboundService: input.outboundService,
		r2Buckets: { OPINION_CACHE: "bundle-conformance" },
		routes: ["mcp.bundle.test/*"],
		scriptPath: input.bundlePath,
	};
}

export function seedWorker(root, compatibilityDate) {
	const migrations = migrationSql(root);
	const seeds = seedStatements();
	return {
		compatibilityDate,
		d1Databases: { DB: "bundle-conformance" },
		modules: [
			{
				contents: `export default { async fetch(_request, env) { for (const migration of ${JSON.stringify(migrations)}) await env.DB.exec(migration); for (const sql of ${JSON.stringify(seeds)}) await env.DB.prepare(sql).run(); return new Response("seeded") } }`,
				path: "seed.mjs",
				type: "ESModule",
			},
		],
		name: "seed",
		routes: ["seed.bundle.test/*"],
	};
}

export function inspectWorker(compatibilityDate) {
	return {
		compatibilityDate,
		d1Databases: { DB: "bundle-conformance" },
		modules: [
			{
				contents:
					"export default { async fetch(_request, env) { const row = await env.DB.prepare('SELECT COUNT(*) AS count FROM opinion_source_states').first(); const objects = await env.OPINION_CACHE.list(); return Response.json({ d1Rows: row?.count ?? 0, r2ObjectCount: objects.objects.length }) } }",
				path: "inspect.mjs",
				type: "ESModule",
			},
		],
		name: "inspect",
		r2Buckets: { OPINION_CACHE: "bundle-conformance" },
		routes: ["inspect.bundle.test/*"],
	};
}

export function trap(request, attemptedUrls, unexpectedUrls) {
	const url = new URL(request.url).toString();
	attemptedUrls.push(url);
	if (!EXPECTED_URLS.includes(url)) {
		unexpectedUrls.push(url);
		return new Response("unexpected fixture outbound", { status: 502 });
	}
	if (url.endsWith("/api-usage/")) return Response.json(usage());
	if (url.endsWith("/citation-lookup/")) return Response.json(citation());
	if (url.endsWith(`/clusters/${CLUSTER_ID}/`)) return Response.json(cluster());
	return Response.json(opinion());
}

export function discoveryRequest() {
	return mcpRequest("server/discover", { _meta: metadata() }, "server/discover");
}

export function quoteRequest() {
	return mcpRequest(
		"tools/call",
		{
			_meta: metadata(),
			arguments: { citation: "347 U.S. 483", quote: QUOTE },
			name: "verify_quote",
		},
		"verify_quote",
	);
}

function mcpRequest(method, params, name) {
	return {
		init: {
			body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
			headers: {
				authorization: `Bearer ${TOKEN}`,
				"content-type": "application/json",
				"mcp-method": method,
				"mcp-name": name,
				"mcp-protocol-version": PROTOCOL_VERSION,
			},
			method: "POST",
		},
		url: "https://mcp.bundle.test/",
	};
}

function metadata() {
	return {
		"io.modelcontextprotocol/clientCapabilities": {},
		"io.modelcontextprotocol/clientInfo": { name: "bundle-conformance", version: "1.0.0" },
		"io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
	};
}

function migrationSql(root) {
	return readdirSync(join(root, "migrations"))
		.sort()
		.map((file) => readFileSync(join(root, "migrations", file), "utf8").replaceAll(/\s+/g, " "));
}

function seedStatements() {
	const hash = createHmac("sha256", PEPPER).update(TOKEN).digest("hex");
	return [
		"INSERT INTO customers (id, retention_expires_at) VALUES ('bundle-customer', NULL)",
		`INSERT INTO api_key_records (public_id, customer_id, environment, hmac_sha256_hex, status, issued_at, expires_at, revoked_at, retention_expires_at, minute_limit, day_limit, limits_version) VALUES ('bundle', 'bundle-customer', 'test', '${hash}', 'active', '2026-08-08T12:00:00.000Z', '2099-01-01T00:00:00.000Z', NULL, NULL, 60, 1000, 1)`,
	];
}

function usage() {
	return {
		current_usage: ["user", "citations", "api_usage"].map((scope) => ({
			blocked: false,
			limit: 200,
			rate: "minute",
			remaining: 200,
			reset_at: "2099-01-01T00:01:00.000Z",
			scope,
			used: 0,
			window_seconds: 60,
		})),
	};
}

function citation() {
	return [
		{
			clusters: [{ absolute_url: "/opinion/108713/example/", id: CLUSTER_ID }],
			normalized_citations: ["347 U.S. 483"],
			status: 200,
		},
	];
}

function cluster() {
	return {
		absolute_url: "/opinion/108713/example/",
		id: CLUSTER_ID,
		sub_opinions: [`https://www.courtlistener.com/api/rest/v4/opinions/${OPINION_ID}/`],
	};
}

function opinion() {
	return {
		cluster: `https://www.courtlistener.com/api/rest/v4/clusters/${CLUSTER_ID}/`,
		html_with_citations: `<article><p>${QUOTE}</p><script>${FIXTURE_SOURCE_TEXT}</script></article>`,
		id: OPINION_ID,
	};
}

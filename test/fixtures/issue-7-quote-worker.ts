import { env, runInDurableObject } from "cloudflare:test";
import {
	CLIENT_CAPABILITIES_META_KEY,
	CLIENT_INFO_META_KEY,
	PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { vi } from "vitest";
import { initialCourtListenerBudgetState } from "../../src/courtlistener/budget.js";
import { createLocalAuthFixture } from "./api-key.js";
import { resetCitationSourceCache } from "./citation-source-cache.js";

const CLUSTER_ID = 108713;

type OpinionFixture = {
	readonly id: number;
	readonly body?: Record<string, unknown>;
	readonly failure?: "throw" | "timeout";
	readonly status?: number;
};

export type QuoteWorkerScenario = {
	readonly opinions: readonly OpinionFixture[];
	readonly usage?: "blocked" | "high";
};

export type QuoteWorkerFixture = {
	readonly outbound: readonly Request[];
	readonly request: (quote?: string) => Request;
};

export async function setupQuoteWorker(scenario: QuoteWorkerScenario): Promise<QuoteWorkerFixture> {
	const auth = await createLocalAuthFixture({ publicId: `quote-${crypto.randomUUID()}` });
	await resetCitationSourceCache(env.DB);
	await env.DB.prepare("DROP TABLE IF EXISTS api_key_records").run();
	await env.DB.prepare(
		"CREATE TABLE api_key_records (public_id TEXT PRIMARY KEY NOT NULL, environment TEXT NOT NULL, hmac_sha256_hex TEXT NOT NULL, status TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT, minute_limit INTEGER NOT NULL DEFAULT 60, day_limit INTEGER NOT NULL DEFAULT 1000, limits_version INTEGER NOT NULL DEFAULT 1)",
	).run();
	await env.DB.prepare(
		"INSERT INTO api_key_records (public_id, environment, hmac_sha256_hex, status, expires_at, revoked_at, minute_limit, day_limit, limits_version) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
	)
		.bind(
			auth.record.public_id,
			auth.record.environment,
			auth.record.hmac_sha256_hex,
			auth.record.status,
			auth.record.expires_at,
			auth.record.revoked_at,
			auth.record.minute_limit,
			auth.record.day_limit,
			auth.record.limits_version,
		)
		.run();
	const coordinator = env.COURTLISTENER_COORDINATOR.getByName(env.COURTLISTENER_CREDENTIAL_ID);
	await runInDurableObject(coordinator, (_instance, state) => {
		state.storage.sql.exec(
			"UPDATE courtlistener_budget_state SET state_json = ?1 WHERE singleton = 1",
			JSON.stringify(initialCourtListenerBudgetState()),
		);
	});
	const outbound: Request[] = [];
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const source = input instanceof Request ? input : new Request(input, init);
		outbound.push(source);
		return sourceResponse(source, scenario);
	});
	return {
		outbound,
		request: (quote = "QUOTE_SENTINEL: equal justice under law.") =>
			quoteRequest(auth.token, quote),
	};
}

function sourceResponse(request: Request, scenario: QuoteWorkerScenario): Promise<Response> {
	const pathname = new URL(request.url).pathname;
	if (pathname.endsWith("/api-usage/"))
		return Promise.resolve(Response.json(usage(scenario.usage)));
	if (pathname.endsWith("/citation-lookup/")) return Promise.resolve(Response.json(citation()));
	if (pathname.endsWith(`/clusters/${CLUSTER_ID}/`))
		return Promise.resolve(Response.json(cluster(scenario.opinions)));
	const opinion = scenario.opinions.find((item) => pathname.endsWith(`/opinions/${item.id}/`));
	if (opinion === undefined) return Promise.resolve(new Response(null, { status: 404 }));
	if (opinion.failure === "throw") return Promise.reject(new Error("fixture transport failure"));
	if (opinion.failure === "timeout") return waitForAbort(request.signal);
	return Promise.resolve(
		opinion.status === undefined
			? Response.json(opinion.body ?? opinionBody(opinion.id))
			: new Response(null, { status: opinion.status, headers: { "retry-after": "3" } }),
	);
}

function waitForAbort(signal: AbortSignal): Promise<Response> {
	return new Promise((_resolve, reject) => {
		if (signal.aborted) return reject(signal.reason);
		signal.addEventListener("abort", () => reject(signal.reason), { once: true });
	});
}

function usage(mode: QuoteWorkerScenario["usage"]) {
	const limit = mode === "high" ? 200 : 5;
	const blocked = mode === "blocked";
	return {
		current_usage: ["user", "citations", "api_usage"].map((scope) => ({
			scope,
			rate: "minute",
			used: blocked ? limit : 0,
			limit,
			remaining: blocked ? 0 : limit,
			window_seconds: 60,
			reset_at: "2099-01-01T00:01:00.000Z",
			blocked,
		})),
	};
}

function citation() {
	return [
		{
			status: 200,
			normalized_citations: ["347 U.S. 483"],
			clusters: [{ id: CLUSTER_ID, absolute_url: "/opinion/108713/example/" }],
		},
	];
}

function cluster(opinions: readonly OpinionFixture[]) {
	return {
		id: CLUSTER_ID,
		absolute_url: "/opinion/108713/example/",
		sub_opinions: opinions.map(
			(opinion) => `https://www.courtlistener.com/api/rest/v4/opinions/${opinion.id}/`,
		),
	};
}

function opinionBody(id: number) {
	return {
		id,
		cluster: `https://www.courtlistener.com/api/rest/v4/clusters/${CLUSTER_ID}/`,
		html_with_citations: "<p>no matching language</p>",
	};
}

function quoteRequest(token: string, quote: string): Request {
	const protocolVersion = "2026-07-28";
	return new Request("https://mcp.lexcerta.ai/", {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
			"mcp-method": "tools/call",
			"mcp-name": "verify_quote",
			"mcp-protocol-version": protocolVersion,
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "verify_quote",
				arguments: { citation: "347 U.S. 483", quote },
				_meta: {
					[PROTOCOL_VERSION_META_KEY]: protocolVersion,
					[CLIENT_INFO_META_KEY]: { name: "issue-7-workerd", version: "1.0.0" },
					[CLIENT_CAPABILITIES_META_KEY]: {},
				},
			},
		}),
	});
}

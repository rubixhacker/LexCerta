import { env, runInDurableObject } from "cloudflare:test";
import {
	CLIENT_CAPABILITIES_META_KEY,
	CLIENT_INFO_META_KEY,
	PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { initialCourtListenerBudgetState } from "../../src/courtlistener/budget.js";
import { createLocalAuthFixture } from "./api-key.js";
import { resetCitationSourceCache } from "./citation-source-cache.js";

export type CitationSourceMode = "absent" | "matched" | "server";

export type Issue6WorkerFixture = {
	readonly authorization: string;
	readonly outbound: Request[];
	readonly request: (citation?: string) => Request;
	readonly resetCache: () => Promise<void>;
	readonly seed: (state: unknown) => Promise<void>;
	readonly setSourceMode: (mode: CitationSourceMode) => void;
	readonly source: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};

const NORMALIZED_CITATION = "347 U.S. 483";
const PROTOCOL_VERSION = "2026-07-28";

export async function createIssue6WorkerFixture(publicId: string): Promise<Issue6WorkerFixture> {
	const localAuth = await createLocalAuthFixture({ publicId });
	await resetCitationSourceCache(env.DB);
	await replaceApiKeyRecords(localAuth.record);
	await resetCourtListenerBudget();

	let sourceMode: CitationSourceMode = "matched";
	const outbound: Request[] = [];
	return {
		authorization: `Bearer ${localAuth.token}`,
		outbound,
		request: (citation = NORMALIZED_CITATION) =>
			citationRequest(`Bearer ${localAuth.token}`, citation),
		resetCache: () => resetCitationSourceCache(env.DB),
		seed: (state) => seedCitationSourceState(state),
		setSourceMode: (mode) => {
			sourceMode = mode;
		},
		source: (input, init) => {
			const request = input instanceof Request ? input : new Request(input, init);
			outbound.push(request);
			if (request.method === "GET") return Promise.resolve(usageResponse());
			switch (sourceMode) {
				case "matched":
					return Promise.resolve(citationResponse(200));
				case "absent":
					return Promise.resolve(citationResponse(404));
				case "server":
					return Promise.resolve(new Response(null, { status: 503 }));
				default:
					return assertNever(sourceMode);
			}
		},
	};
}

export function positiveState(retrievedAt: Date) {
	return {
		kind: "positive",
		positive: {
			kind: "positive",
			cluster: {
				id: 108713,
				canonicalUrl: "https://www.courtlistener.com/opinion/108713/brown-v-board-of-education/",
			},
			retrievedAt: retrievedAt.toISOString(),
		},
	};
}

export function pendingReversalState(firstNegativeAt: Date) {
	return {
		kind: "reversal_pending",
		superseded: positiveState(new Date(firstNegativeAt.getTime() - 31 * 24 * 60 * 60 * 1_000))
			.positive,
		firstNegative: { kind: "negative", retrievedAt: firstNegativeAt.toISOString() },
	};
}

async function replaceApiKeyRecords(record: {
	readonly public_id: string;
	readonly environment: string;
	readonly hmac_sha256_hex: string;
	readonly status: string;
	readonly expires_at: string;
	readonly revoked_at: string | null;
	readonly minute_limit: number;
	readonly day_limit: number;
	readonly limits_version: number;
}): Promise<void> {
	await env.DB.prepare("DROP TABLE IF EXISTS api_key_records").run();
	await env.DB.prepare(`CREATE TABLE api_key_records (
		public_id TEXT PRIMARY KEY NOT NULL, environment TEXT NOT NULL, hmac_sha256_hex TEXT NOT NULL,
		status TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT,
		minute_limit INTEGER NOT NULL DEFAULT 60, day_limit INTEGER NOT NULL DEFAULT 1000,
		limits_version INTEGER NOT NULL DEFAULT 1
	)`).run();
	await env.DB.prepare(
		"INSERT INTO api_key_records (public_id, environment, hmac_sha256_hex, status, expires_at, revoked_at, minute_limit, day_limit, limits_version) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
	)
		.bind(
			record.public_id,
			record.environment,
			record.hmac_sha256_hex,
			record.status,
			record.expires_at,
			record.revoked_at,
			record.minute_limit,
			record.day_limit,
			record.limits_version,
		)
		.run();
}

async function resetCourtListenerBudget(): Promise<void> {
	const coordinator = env.COURTLISTENER_COORDINATOR.getByName(env.COURTLISTENER_CREDENTIAL_ID);
	await runInDurableObject(coordinator, (_instance, state) => {
		state.storage.sql.exec(
			"UPDATE courtlistener_budget_state SET state_json = ?1 WHERE singleton = 1",
			JSON.stringify(initialCourtListenerBudgetState()),
		);
	});
}

function citationRequest(authorization: string, citation: string): Request {
	return new Request("https://mcp.lexcerta.ai/", {
		method: "POST",
		headers: {
			authorization,
			"content-type": "application/json",
			"mcp-method": "tools/call",
			"mcp-name": "verify_citation",
			"mcp-protocol-version": PROTOCOL_VERSION,
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "verify_citation",
				arguments: { citation },
				_meta: {
					[PROTOCOL_VERSION_META_KEY]: PROTOCOL_VERSION,
					[CLIENT_INFO_META_KEY]: { name: "issue-6", version: "1.0.0" },
					[CLIENT_CAPABILITIES_META_KEY]: {},
				},
			},
		}),
	});
}

async function seedCitationSourceState(state: unknown): Promise<void> {
	await env.DB.prepare(
		"INSERT INTO citation_source_states (normalized_citation, state_json, updated_at) VALUES (?1, ?2, ?3)",
	)
		.bind(NORMALIZED_CITATION, JSON.stringify(state), new Date().toISOString())
		.run();
}

function usageResponse(): Response {
	return Response.json({
		current_usage: ["user", "citations", "api_usage"].map((scope) => ({
			scope,
			rate: "minute",
			used: 0,
			limit: 5,
			remaining: 5,
			window_seconds: 60,
			reset_at: "2026-08-09T12:01:00.000Z",
			blocked: false,
		})),
	});
}

function citationResponse(status: 200 | 404): Response {
	return Response.json([
		{
			status,
			normalized_citations: [NORMALIZED_CITATION],
			clusters:
				status === 200
					? [{ id: 108713, absolute_url: "/opinion/108713/brown-v-board-of-education/" }]
					: [],
		},
	]);
}

function assertNever(value: never): never {
	throw new TypeError(`Unexpected fixture value: ${String(value)}`);
}

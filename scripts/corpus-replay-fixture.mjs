import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
	CLIENT_CAPABILITIES_META_KEY,
	CLIENT_INFO_META_KEY,
	PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { createCourtListenerApi } from "../build/courtlistener/api.js";
import { initialCourtListenerBudgetState } from "../build/courtlistener/budget.js";
import { createCourtListenerCaseLawApi } from "../build/courtlistener/case-law-api.js";
import { createCourtListenerCaseLawGateway } from "../build/courtlistener/case-law-gateway.js";
import { createCourtListenerCitationGateway } from "../build/courtlistener/gateway.js";
import { createLexCertaMcpHandler } from "../build/mcp.js";
import { createPostgresCitationStore } from "../build/postgres/citations.js";
import { PostgresOpinionSources } from "../build/postgres/opinions.js";
import { createCachedCitationGateway } from "../build/verification/cached-citation-gateway.js";
import { EvidenceRequest, MAX_SOURCE_BYTES } from "../build/verification/evidence-request.js";
import { verifyCitationOutputSchema } from "../build/verification/verify-citation.js";
import { verifyQuoteOutputSchema } from "../build/verification/verify-quote.js";
import { FixtureSourceObjects } from "../test/postgres/objects-fixture.mjs";

// PostgreSQL and normalization are real. GCS generations and upstream responses
// are fixtures. The coordinator grants synthetic capacity; it proves no quota entitlement.
export class CorpusReplayFixture {
	objects = new FixtureSourceObjects();
	calls = [];
	constructor(database, normalize) {
		this.database = database;
		this.normalize = normalize;
		this.citations = createPostgresCitationStore(database.database);
		this.opinions = new PostgresOpinionSources(database.database, this.objects);
	}

	async replay(vector) {
		await this.seedHistory(vector);
		const start = performance.now();
		const firstCall = this.calls.length;
		const request = new EvidenceRequest();
		const state = initialCourtListenerBudgetState();
		const coordinator = {
			admit: async ({ reservationToken }) =>
				vector.mode === "quota-unknown"
					? { kind: "quota_exhausted", state, retryAt: null }
					: { kind: "reserved", token: reservationToken, state },
			recordOutcome: async () => ({ kind: "recorded", state }),
			beginQuotaSync: async () => ({ kind: "already_in_progress", state }),
		};
		const transport = async (source) => {
			const url = new URL(source.url);
			assert.equal(url.origin, "https://www.courtlistener.com");
			assert.equal(source.redirect, "manual");
			this.calls.push({ path: url.pathname, fields: url.searchParams.get("fields") });
			return this.response(vector, source, url);
		};
		const api = createCourtListenerApi({ request, token: "offline-fixture-only", transport });
		const citation = createCachedCitationGateway({
			request,
			store: this.citations,
			now: () => new Date(),
			ownerToken: randomUUID,
			upstream: createCourtListenerCitationGateway({
				api,
				coordinator,
				now: () => new Date(),
				token: randomUUID,
			}),
		});
		const quote = createCourtListenerCaseLawGateway({
			request,
			api: createCourtListenerCaseLawApi({ request, token: "offline-fixture-only", transport }),
			quotaApi: api,
			coordinator,
			now: () => new Date(),
			opinions: this.opinions,
			token: randomUUID,
		});
		try {
			const tool = vector.tool ?? "verify_quote";
			const args = {
				citation: vector.inputCitation ?? vector.citation,
				...(tool === "verify_quote" ? { quote: vector.quote } : {}),
			};
			const response = await createLexCertaMcpHandler({
				request,
				normalize: this.normalize,
				citation,
				quote,
			}).fetch(
				new Request("http://localhost/", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"mcp-protocol-version": "2026-07-28",
						"mcp-method": "tools/call",
						"mcp-name": tool,
					},
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: 1,
						method: "tools/call",
						params: {
							name: tool,
							arguments: args,
							_meta: {
								[PROTOCOL_VERSION_META_KEY]: "2026-07-28",
								[CLIENT_INFO_META_KEY]: { name: "offline-corpus-replay", version: "1" },
								[CLIENT_CAPABILITIES_META_KEY]: {},
							},
						},
					}),
				}),
			);
			const body = await response.json();
			const result = body.result?.structuredContent;
			const parsed = (
				tool === "verify_quote" ? verifyQuoteOutputSchema : verifyCitationOutputSchema
			).safeParse(result);
			let evidenceCorrect = response.status === 200 && parsed.success;
			if (evidenceCorrect && result.evidence !== undefined) {
				evidenceCorrect = result.evidence.normalizedCitation === vector.citation;
			}
			if (vector.quote !== undefined)
				assert.ok(
					!JSON.stringify(body).includes(vector.quote),
					"Submitted quote leaked into the tool response",
				);
			if (evidenceCorrect && result.outcome === "verified") {
				evidenceCorrect =
					result.evidence.cluster.id === vector.clusterId &&
					result.evidence.cluster.canonicalUrl === vector.canonicalUrl;
				if (tool === "verify_quote")
					evidenceCorrect &&= (
						vector.matchingOpinionIds ?? [vector.opinions[vector.matchingIndex ?? 0].id]
					).includes(result.evidence.matchingOpinion.id);
			}
			if (evidenceCorrect && result.outcome === "not_found") {
				evidenceCorrect = result.evidence.searchComplete === true;
				if (tool === "verify_quote")
					evidenceCorrect &&=
						result.evidence.requiredOpinionCount === vector.opinions.length &&
						result.evidence.searchedOpinionCount === vector.opinions.length &&
						vector.opinions.every((opinion) =>
							result.evidence.searchedOpinions.some((searched) => searched.id === opinion.id),
						);
			}
			return {
				id: vector.id,
				kind: vector.kind,
				split: vector.split ?? "synthetic",
				category: vector.category,
				clusterId: vector.clusterId,
				stratum: vector.stratum ?? null,
				attributes: vector.attributes ?? {},
				expected: vector.expected,
				outcome: result?.outcome ?? "invalid_response",
				reason: result?.reason ?? null,
				passed:
					evidenceCorrect &&
					result.outcome === vector.expected &&
					(vector.reason === undefined || result.reason === vector.reason),
				evidenceCorrect,
				elapsedMs: performance.now() - start,
				sourceResponseBytes: request.responseBytes,
				processedSourceBytes: request.sourceBytes,
				sourceRequests: this.calls.length - firstCall,
			};
		} finally {
			request.close();
		}
	}

	async response(vector, request, url) {
		if (url.pathname.endsWith("/citation-lookup/")) {
			assert.equal(request.method, "POST");
			assert.deepEqual([...(await request.formData()).entries()], [["text", vector.citation]]);
			if (vector.mode === "stale-negative-citation") return new Response(null, { status: 500 });
			if (vector.mode === "quota-rate-limited")
				return new Response(null, { status: 429, headers: { "retry-after": "5" } });
			const clusters = [{ id: vector.clusterId, canonical_url: vector.canonicalUrl }];
			if (vector.mode === "ambiguous-clusters")
				clusters.push({
					id: vector.clusterId + 1,
					canonical_url: vector.canonicalUrl.replace(
						String(vector.clusterId),
						String(vector.clusterId + 1),
					),
				});
			return Response.json([
				{
					status:
						vector.mode === "reversal-citation"
							? 404
							: vector.mode === "ambiguous-status"
								? 300
								: 200,
					normalized_citations: [
						vector.mode === "ambiguous-normalization" ? "999 U.S. 999" : vector.citation,
					],
					clusters: vector.mode === "reversal-citation" ? [] : clusters,
				},
			]);
		}
		if (url.pathname === `/api/rest/v4/clusters/${vector.clusterId}/`) {
			assert.equal(url.searchParams.get("fields"), "id,absolute_url,sub_opinions");
			return Response.json({
				id: vector.clusterId,
				absolute_url: vector.canonicalUrl,
				sub_opinions: vector.opinions.map(
					(opinion) => `https://www.courtlistener.com/api/rest/v4/opinions/${opinion.id}/`,
				),
			});
		}
		const index = vector.opinions.findIndex(
			(opinion) => url.pathname === `/api/rest/v4/opinions/${opinion.id}/`,
		);
		assert.ok(index >= 0, "Unexpected offline route; no network fallback exists");
		assert.equal(url.searchParams.get("fields"), "id,cluster,html_with_citations,html,plain_text");
		if (
			vector.mode === "stale-negative-opinion" ||
			(index === 1 && vector.mode === "partial-server")
		)
			return new Response(null, { status: 500 });
		if (vector.mode === "reversal-opinion" || (index === 1 && vector.mode === "partial-missing"))
			return new Response(null, { status: 404 });
		if (index === 1 && vector.mode === "partial-transport")
			throw new Error("Injected offline transport failure");
		if (vector.mode === "truncated-json") return new Response('{"id":');
		if (vector.mode === "invalid-utf8") return new Response(Buffer.from([0x22, 0xc3, 0x28, 0x22]));
		const opinion = vector.opinions[index];
		return Response.json({
			id: opinion.id,
			cluster: `https://www.courtlistener.com/api/rest/v4/clusters/${vector.clusterId}/`,
			...(vector.mode === "oversized"
				? { plain_text: "x".repeat(MAX_SOURCE_BYTES) }
				: opinion.fields),
		});
	}

	async seedHistory(vector) {
		const mode = vector.mode ?? "";
		if (!mode.startsWith("stale-negative-") && !mode.startsWith("reversal-")) return;
		const old = new Date(Date.now() - 31 * 86400000).toISOString();
		if (mode.endsWith("citation")) {
			const state = mode.startsWith("stale")
				? { kind: "negative", negative: { kind: "negative", retrievedAt: old }, superseded: null }
				: {
						kind: "positive",
						positive: {
							kind: "positive",
							retrievedAt: old,
							cluster: { id: vector.clusterId, canonicalUrl: vector.canonicalUrl },
						},
					};
			await this.database.migration.query(
				"INSERT INTO lexcerta.citation_sources(citation, state) VALUES ($1, $2)",
				[vector.citation, JSON.stringify(state)],
			);
		} else {
			const provenance = {
				opinionId: vector.opinions[0].id,
				clusterId: vector.clusterId,
				canonicalUrl: vector.canonicalUrl,
			};
			const state = mode.startsWith("stale")
				? {
						kind: "negative",
						negative: { kind: "negative", retrievedAt: old, provenance },
						superseded: null,
					}
				: {
						kind: "positive",
						positive: {
							kind: "positive",
							retrievedAt: old,
							provenance,
							representation: "plain_text",
							objectKey: "fixture/previously-evicted-object",
							contentHash: `sha256:${"a".repeat(64)}`,
						},
					};
			// Positive history with a null body pointer models normal cache eviction.
			await this.database.migration.query(
				"INSERT INTO lexcerta.opinion_sources(opinion_id, state) VALUES ($1, $2)",
				[provenance.opinionId, JSON.stringify(state)],
			);
		}
	}
}

import { CONTRACT_VERSION, parseCitation } from "./citation.js";
import type { CitationVerificationGateway, CourtListenerCluster } from "./verify-citation.js";
import {
	canonicalOpinionText,
	normalizeQuoteText,
	selectOpinionText,
	type QuoteIndeterminateReason,
	type VerifyQuoteInput,
	type VerifyQuoteResult,
	type OpinionTextSource,
	verifyQuoteInputSchema,
	verifyQuoteOutputSchema,
} from "./quote-contract.js";
export { verifyQuoteInputSchema, verifyQuoteOutputSchema } from "./quote-contract.js";
export type { VerifyQuoteInput, VerifyQuoteResult } from "./quote-contract.js";

export type QuoteCluster = CourtListenerCluster & { readonly opinionUrls: readonly string[] };

export type QuoteOpinion = {
	readonly id: number;
	readonly clusterId: number;
	readonly canonicalUrl: string;
	readonly text: OpinionTextSource;
	readonly retrievedAt: string;
	readonly freshness: "fresh" | "stale";
};

type QuoteFailureReason =
	| "incomplete"
	| "timeout"
	| "upstream_unavailable"
	| "quota_unknown"
	| "source_changed"
	| "rate_limited"
	| "circuit_open";

type QuoteClusterObservation =
	| { readonly kind: "found"; readonly cluster: QuoteCluster }
	| {
			readonly kind: "indeterminate";
			readonly reason: QuoteFailureReason;
			readonly retryAfterSeconds?: number;
	  };

type QuoteOpinionObservation =
	| { readonly kind: "found"; readonly opinion: QuoteOpinion }
	| {
			readonly kind: "indeterminate";
			readonly reason: QuoteFailureReason;
			readonly retryAfterSeconds?: number;
	  };

export interface QuoteVerificationGateway {
	readCluster(cluster: CourtListenerCluster): Promise<QuoteClusterObservation>;
	readOpinion(input: {
		readonly cluster: QuoteCluster;
		readonly opinionUrl: string;
	}): Promise<QuoteOpinionObservation>;
}

export async function verifyQuote(
	input: VerifyQuoteInput,
	citationGateway: CitationVerificationGateway,
	quoteGateway: QuoteVerificationGateway,
	options: { readonly maxOpinions: number },
): Promise<VerifyQuoteResult> {
	const parsed = parseCitation(input.citation);
	if (parsed.outcome === "unrecognized") return indeterminate("unsupported_citation");
	const citation = await citationGateway.lookup({
		volume: parsed.citation.volume,
		reporter: parsed.citation.reporter,
		page: parsed.citation.page,
		normalizedCitation: parsed.citation.normalized,
	});
	switch (citation.kind) {
		case "verified":
			return searchCluster(
				input.quote,
				parsed.citation.normalized,
				citation.cluster,
				citation.retrievedAt,
				citation.freshness,
				quoteGateway,
				options,
			);
		case "not_found":
			return {
				outcome: "not_found",
				contractVersion: CONTRACT_VERSION,
				evidence: {
					source: "courtlistener",
					normalizedCitation: parsed.citation.normalized,
					citationRetrievedAt: citation.retrievedAt,
					citationFreshness: "fresh",
					cluster: null,
					searchedOpinionCount: 0,
					requiredOpinionCount: 0,
					searchComplete: true,
					searchedOpinions: [],
				},
			};
		case "indeterminate":
			switch (citation.reason) {
				case "rate_limited":
				case "circuit_open":
					return indeterminate(citation.reason, citation.retryAfterSeconds);
				case "incomplete":
				case "timeout":
				case "upstream_unavailable":
				case "quota_unknown":
				case "source_changed":
					return indeterminate(citation.reason);
			}
	}
}

async function searchCluster(
	quote: string,
	normalizedCitation: string,
	cluster: CourtListenerCluster,
	citationRetrievedAt: string,
	citationFreshness: "fresh" | "stale",
	quoteGateway: QuoteVerificationGateway,
	options: { readonly maxOpinions: number },
): Promise<VerifyQuoteResult> {
	const clusterResult = await quoteGateway.readCluster(cluster);
	if (clusterResult.kind === "indeterminate")
		return indeterminate(clusterResult.reason, clusterResult.retryAfterSeconds);
	const requiredOpinionCount = clusterResult.cluster.opinionUrls.length;
	if (requiredOpinionCount === 0) return indeterminate("source_text_unavailable");
	if (requiredOpinionCount > options.maxOpinions) return indeterminate("cluster_limit_exceeded");
	const normalizedQuote = normalizeQuoteText(quote);
	const searchedOpinions: Array<{
		readonly id: number;
		readonly canonicalUrl: string;
		readonly representation: "html_with_citations" | "html" | "plain_text";
		readonly retrievedAt: string;
		readonly freshness: "fresh" | "stale";
	}> = [];
	for (const opinionUrl of clusterResult.cluster.opinionUrls) {
		const opinionResult = await quoteGateway.readOpinion({
			cluster: clusterResult.cluster,
			opinionUrl,
		});
		if (opinionResult.kind === "indeterminate")
			return indeterminate(opinionResult.reason, opinionResult.retryAfterSeconds);
		const selected = selectOpinionText(opinionResult.opinion.text);
		if (selected === undefined) return indeterminate("source_text_unavailable");
		const canonicalText = await canonicalOpinionText(selected);
		if (canonicalText.length === 0) return indeterminate("source_text_unavailable");
		searchedOpinions.push({
			id: opinionResult.opinion.id,
			canonicalUrl: opinionResult.opinion.canonicalUrl,
			representation: selected.representation,
			retrievedAt: opinionResult.opinion.retrievedAt,
			freshness: opinionResult.opinion.freshness,
		});
		if (canonicalText.includes(normalizedQuote)) {
			return {
				outcome: "verified",
				contractVersion: CONTRACT_VERSION,
				evidence: {
					...evidence(
						normalizedCitation,
						clusterResult.cluster,
						citationRetrievedAt,
						citationFreshness,
						searchedOpinions,
						requiredOpinionCount,
						searchedOpinions.length === requiredOpinionCount,
					),
					matchingOpinion: {
						id: opinionResult.opinion.id,
						canonicalUrl: opinionResult.opinion.canonicalUrl,
					},
					representation: selected.representation,
					retrievedAt: opinionResult.opinion.retrievedAt,
					freshness: opinionResult.opinion.freshness,
				},
			};
		}
	}
	if (searchedOpinions.some((opinion) => opinion.freshness === "stale"))
		return indeterminate("incomplete");
	return {
		outcome: "not_found",
		contractVersion: CONTRACT_VERSION,
		evidence: evidence(
			normalizedCitation,
			clusterResult.cluster,
			citationRetrievedAt,
			citationFreshness,
			searchedOpinions,
			requiredOpinionCount,
			true,
		),
	};
}

function evidence(
	normalizedCitation: string,
	cluster: QuoteCluster,
	citationRetrievedAt: string,
	citationFreshness: "fresh" | "stale",
	searchedOpinions: readonly {
		readonly id: number;
		readonly canonicalUrl: string;
		readonly representation: "html_with_citations" | "html" | "plain_text";
		readonly retrievedAt: string;
		readonly freshness: "fresh" | "stale";
	}[],
	requiredOpinionCount: number,
	searchComplete: boolean,
) {
	return {
		source: "courtlistener" as const,
		normalizedCitation,
		citationRetrievedAt,
		citationFreshness,
		cluster: { id: cluster.id, canonicalUrl: cluster.canonicalUrl },
		searchedOpinionCount: searchedOpinions.length,
		requiredOpinionCount,
		searchComplete,
		searchedOpinions: [...searchedOpinions],
	};
}

function indeterminate(
	reason: QuoteIndeterminateReason,
	retryAfterSeconds?: number,
): VerifyQuoteResult {
	return reason === "unsupported_citation"
		? {
				outcome: "indeterminate",
				contractVersion: CONTRACT_VERSION,
				reason,
				retry: { action: "use_supported_citation" },
			}
		: {
				outcome: "indeterminate",
				contractVersion: CONTRACT_VERSION,
				reason,
				retry:
					retryAfterSeconds === undefined
						? { action: "retry_later" }
						: { action: "retry_later", retryAfterSeconds },
			};
}

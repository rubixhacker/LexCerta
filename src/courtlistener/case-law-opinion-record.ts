import type { CachedOpinion } from "../cache/opinion-cache-store.js";
import type {
	OpinionTextRepresentation,
	OpinionTextSource,
} from "../verification/quote-contract.js";
import type { QuoteCluster } from "../verification/verify-quote.js";
import type { CourtListenerCaseLawOpinion } from "./case-law-api.js";

const DEFAULT_FRESHNESS_MS = 30 * 24 * 60 * 60 * 1_000;

export function cachedOpinion(
	opinionId: number,
	cluster: QuoteCluster,
	selected: { readonly content: string; readonly representation: OpinionTextRepresentation },
	now: Date,
	opinionFreshnessMs: number | undefined,
): CachedOpinion {
	return {
		canonicalUrl: cluster.canonicalUrl,
		clusterId: cluster.id,
		freshUntil: new Date(now.getTime() + (opinionFreshnessMs ?? DEFAULT_FRESHNESS_MS)),
		opinionId,
		representation: selected.representation,
		retrievedAt: now,
		sourceText: selected.content,
	};
}

export function foundOpinion(opinion: CachedOpinion, freshness: "fresh" | "stale") {
	return {
		kind: "found" as const,
		opinion: {
			canonicalUrl: opinion.canonicalUrl,
			clusterId: opinion.clusterId,
			freshness,
			id: opinion.opinionId,
			retrievedAt: opinion.retrievedAt.toISOString(),
			text: sourceFromCached(opinion),
		},
	};
}

export function freshness(opinion: CachedOpinion, now: Date): "fresh" | "stale" {
	return now.getTime() < opinion.freshUntil.getTime() ? "fresh" : "stale";
}

export function matchesCluster(opinion: CachedOpinion, cluster: QuoteCluster): boolean {
	return opinion.clusterId === cluster.id && opinion.canonicalUrl === cluster.canonicalUrl;
}

export function opinionIdFromUrl(value: string): number | undefined {
	try {
		const url = new URL(value);
		const id = Number(/^\/api\/rest\/v4\/opinions\/(\d+)\/$/.exec(url.pathname)?.[1]);
		return url.origin === "https://www.courtlistener.com" && Number.isSafeInteger(id) && id > 0
			? id
			: undefined;
	} catch {
		return undefined;
	}
}

export function sourceText(opinion: CourtListenerCaseLawOpinion): OpinionTextSource {
	return {
		...(opinion.html === undefined ? {} : { html: opinion.html }),
		...(opinion.htmlWithCitations === undefined
			? {}
			: { html_with_citations: opinion.htmlWithCitations }),
		...(opinion.plainText === undefined ? {} : { plain_text: opinion.plainText }),
	};
}

function sourceFromCached(opinion: CachedOpinion): OpinionTextSource {
	switch (opinion.representation) {
		case "html_with_citations":
			return { html_with_citations: opinion.sourceText };
		case "html":
			return { html: opinion.sourceText };
		case "plain_text":
			return { plain_text: opinion.sourceText };
	}
}

import type { OpinionSourceReadResult, OpinionSourceStore } from "../cache/opinion-source-store.js";
import {
	type OpinionSourceCacheDecision,
	type OpinionSourceProvenance,
	initialOpinionSourceCacheState,
	readOpinionSourceCache,
} from "../verification/opinion-source-cache.js";
import type { OpinionTextSource } from "../verification/quote-contract.js";
import type { QuoteOpinion } from "../verification/verify-quote.js";
import type { CourtListenerCaseLawOpinion } from "./case-law-api.js";

const INITIAL_WAIT_MS = 50;
const MAX_WAIT_MS = 1_000;

export type OpinionFailureReason =
	| "incomplete"
	| "quota_unknown"
	| "rate_limited"
	| "circuit_open"
	| "timeout"
	| "upstream_unavailable"
	| "source_changed";

export type OpinionResult =
	| { readonly kind: "found"; readonly opinion: QuoteOpinion }
	| {
			readonly kind: "indeterminate";
			readonly reason: OpinionFailureReason;
			readonly retryAfterSeconds?: number;
	  };

export type OpinionCacheReadOptions = {
	readonly now: () => Date;
	readonly store: OpinionSourceStore;
	readonly waitForFill?: (delayMilliseconds: number) => Promise<void>;
};

export type UsableCache = {
	readonly kind: "usable";
	readonly read: Extract<OpinionSourceReadResult, { readonly kind: "positive" }>;
	readonly decision: Extract<OpinionSourceCacheDecision, { readonly kind: "available" }>;
};
export type Cached =
	| UsableCache
	| {
			readonly kind: "decided";
			readonly decision: OpinionSourceCacheDecision;
			readonly read: OpinionSourceReadResult | null;
	  }
	| { readonly kind: "failure" };

export async function cached(
	options: OpinionCacheReadOptions,
	provenance: OpinionSourceProvenance,
): Promise<Cached> {
	let read: OpinionSourceReadResult | null;
	try {
		read = await options.store.read({ provenance });
	} catch (error) {
		if (error instanceof Error) return { kind: "failure" };
		throw error;
	}
	if (read === null)
		return {
			kind: "decided",
			read: null,
			decision: readOpinionSourceCache({
				state: initialOpinionSourceCacheState(),
				now: options.now(),
			}),
		};
	const decision = readOpinionSourceCache({ state: read.state, now: options.now() });
	return read.kind === "positive" && decision.kind === "available"
		? { kind: "usable", read, decision }
		: { kind: "decided", decision, read };
}

export async function waitForWinner(
	options: OpinionCacheReadOptions,
	provenance: OpinionSourceProvenance,
	expiresAt: string,
): Promise<Cached> {
	const deadline = new Date(expiresAt).getTime();
	let delay = INITIAL_WAIT_MS;
	while (Number.isFinite(deadline)) {
		const before = options.now().getTime();
		const remaining = deadline - before;
		if (remaining <= 0) break;
		await (options.waitForFill ?? wait)(Math.min(delay, remaining));
		const result = await cached(options, provenance);
		if (result.kind === "failure") return result;
		if (
			(result.kind === "usable" && !result.decision.requiresRevalidation) ||
			(result.kind === "decided" && !result.decision.requiresRevalidation)
		)
			return result;
		if (options.now().getTime() <= before) break;
		delay = Math.min(delay * 2, MAX_WAIT_MS);
	}
	return {
		kind: "decided",
		read: null,
		decision: readOpinionSourceCache({
			state: initialOpinionSourceCacheState(),
			now: options.now(),
		}),
	};
}

export async function durableWinner(
	options: OpinionCacheReadOptions,
	provenance: OpinionSourceProvenance,
	retained: UsableCache | undefined,
	suppressRetainedPositive = false,
): Promise<OpinionResult> {
	const winner = await cached(options, provenance);
	if (winner.kind === "failure") return indeterminate("upstream_unavailable");
	if (winner.kind === "usable") {
		if (
			suppressRetainedPositive &&
			retained !== undefined &&
			winner.read.state.positive.objectKey === retained.read.state.positive.objectKey &&
			winner.read.state.positive.retrievedAt.getTime() ===
				retained.read.state.positive.retrievedAt.getTime()
		)
			return indeterminate("upstream_unavailable");
		return found(winner.read, winner.decision.freshness);
	}
	if (winner.decision.kind === "indeterminate") {
		if (winner.decision.reason === "source_changed") return indeterminate("source_changed");
		return winner.decision.reason === "cache_miss"
			? fallback(retained, "upstream_unavailable")
			: indeterminate("incomplete");
	}
	if (winner.decision.kind === "source_unavailable") return indeterminate("incomplete");
	return indeterminate("upstream_unavailable");
}

export function found(
	read: Extract<OpinionSourceReadResult, { readonly kind: "positive" }>,
	freshness: "fresh" | "stale",
): OpinionResult {
	const positive = read.state.positive;
	return foundSource(
		positive.provenance,
		positive.representation,
		read.sourceText,
		positive.retrievedAt,
		freshness,
	);
}

export function foundSource(
	provenance: OpinionSourceProvenance,
	representation: "html_with_citations" | "html" | "plain_text",
	source: string,
	retrievedAt: Date,
	freshness: "fresh" | "stale",
): OpinionResult {
	const text: OpinionTextSource =
		representation === "html_with_citations"
			? { html_with_citations: source }
			: representation === "html"
				? { html: source }
				: { plain_text: source };
	return {
		kind: "found",
		opinion: {
			canonicalUrl: provenance.canonicalUrl,
			clusterId: provenance.clusterId,
			freshness,
			id: provenance.opinionId,
			retrievedAt: retrievedAt.toISOString(),
			text,
		},
	};
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

export function opinionIdFromUrl(value: string): number | undefined {
	try {
		const url = new URL(value);
		const raw = /^\/api\/rest\/v4\/opinions\/(\d+)\/$/.exec(url.pathname)?.[1];
		const id = raw === undefined ? Number.NaN : Number(raw);
		return url.origin === "https://www.courtlistener.com" && Number.isSafeInteger(id) && id > 0
			? id
			: undefined;
	} catch {
		return undefined;
	}
}

export function fallback(
	retained: UsableCache | undefined,
	reason: OpinionFailureReason,
	retryAfterSeconds?: number,
): OpinionResult {
	return retained === undefined
		? indeterminate(reason, retryAfterSeconds)
		: found(retained.read, "stale");
}

export function indeterminate(
	reason: OpinionFailureReason,
	retryAfterSeconds?: number,
): OpinionResult {
	return {
		kind: "indeterminate",
		reason,
		...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
	};
}

function wait(delayMilliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, delayMilliseconds));
}

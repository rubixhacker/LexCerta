import type { CachedOpinion, OpinionCacheStore } from "../cache/opinion-cache-store.js";
import { type OpinionTextSource, selectOpinionText } from "../verification/quote-contract.js";
import type { QuoteCluster } from "../verification/verify-quote.js";
import type { CaseLawRequestFailure } from "./case-law-admission.js";
import type { CourtListenerCaseLawOpinion, CourtListenerCaseLawOutcome } from "./case-law-api.js";
import {
	cachedOpinion,
	foundOpinion,
	freshness,
	matchesCluster,
	opinionIdFromUrl,
	sourceText,
} from "./case-law-opinion-record.js";

const INITIAL_DELAY_MS = 50;
const MAX_DELAY_MS = 1_000;

type FailureReason =
	| "incomplete"
	| "quota_unknown"
	| "rate_limited"
	| "circuit_open"
	| "timeout"
	| "upstream_unavailable";

export type CaseLawOpinionCacheOptions = {
	readonly fetch: (
		url: string,
	) => Promise<
		| CourtListenerCaseLawOutcome<{ readonly opinion: CourtListenerCaseLawOpinion }>
		| CaseLawRequestFailure
		| undefined
	>;
	readonly now: () => Date;
	readonly opinionFreshnessMs?: number;
	readonly opinions: OpinionCacheStore;
	readonly token: () => string;
	readonly waitForFill?: (delayMilliseconds: number) => Promise<void>;
};

export async function readCaseLawOpinion(
	input: { readonly cluster: QuoteCluster; readonly opinionUrl: string },
	options: CaseLawOpinionCacheOptions,
): Promise<
	| {
			readonly kind: "found";
			readonly opinion: {
				readonly canonicalUrl: string;
				readonly clusterId: number;
				readonly freshness: "fresh" | "stale";
				readonly id: number;
				readonly retrievedAt: string;
				readonly text: OpinionTextSource;
			};
	  }
	| {
			readonly kind: "indeterminate";
			readonly reason: FailureReason;
			readonly retryAfterSeconds?: number;
	  }
> {
	const opinionId = opinionIdFromUrl(input.opinionUrl);
	if (opinionId === undefined) return indeterminate("incomplete");
	const cached = await readCached(options, opinionId, input.cluster);
	if (cached.kind === "fresh") return foundOpinion(cached.opinion, "fresh");
	const retained = cached.kind === "stale" ? cached.opinion : undefined;
	const ownerToken = options.token();
	const lease = await value(() =>
		options.opinions.acquireLease({ opinionId, ownerToken, now: options.now() }),
	);
	if (lease === undefined) return fallback(retained, "upstream_unavailable");
	if (lease.kind === "held") {
		const filled = await waitForCached(options, opinionId, input.cluster, lease.expiresAt);
		return filled === undefined
			? fallback(retained, "upstream_unavailable")
			: foundOpinion(filled, freshness(filled, options.now()));
	}
	const rechecked = await readCached(options, opinionId, input.cluster);
	if (rechecked.kind === "fresh") {
		await release(options, opinionId, ownerToken);
		return foundOpinion(rechecked.opinion, "fresh");
	}
	const source = await options.fetch(input.opinionUrl);
	if (source === undefined) {
		await release(options, opinionId, ownerToken);
		return fallback(retained, "quota_unknown");
	}
	if (source.kind === "indeterminate") {
		await release(options, opinionId, ownerToken);
		return fallback(retained, source.reason, source.retryAfterSeconds);
	}
	if (source.kind !== "found") {
		await release(options, opinionId, ownerToken);
		return fallback(retained, failure(source));
	}
	if (source.opinion.clusterId !== input.cluster.id) {
		await release(options, opinionId, ownerToken);
		return fallback(retained, "incomplete");
	}
	const text = sourceText(source.opinion);
	const selected = selectOpinionText(text);
	if (selected === undefined) {
		await release(options, opinionId, ownerToken);
	} else {
		const filled = await value(() =>
			options.opinions.fillLease({
				now: options.now(),
				ownerToken,
				opinion: cachedOpinion(
					source.opinion.id,
					input.cluster,
					selected,
					options.now(),
					options.opinionFreshnessMs,
				),
			}),
		);
		if (filled?.kind !== "stored") {
			const winner = await readCached(options, opinionId, input.cluster);
			return winner.kind === "missing"
				? fallback(retained, "upstream_unavailable")
				: foundOpinion(winner.opinion, freshness(winner.opinion, options.now()));
		}
	}
	return {
		kind: "found",
		opinion: {
			canonicalUrl: input.cluster.canonicalUrl,
			clusterId: input.cluster.id,
			freshness: "fresh",
			id: source.opinion.id,
			retrievedAt: options.now().toISOString(),
			text,
		},
	};
}

function fallback(
	opinion: CachedOpinion | undefined,
	reason: FailureReason,
	retryAfterSeconds?: number,
) {
	return opinion === undefined
		? indeterminate(reason, retryAfterSeconds)
		: foundOpinion(opinion, "stale");
}

function failure(
	source: CourtListenerCaseLawOutcome<{ readonly opinion: CourtListenerCaseLawOpinion }>,
): FailureReason {
	switch (source.kind) {
		case "rate_limited":
			return "rate_limited";
		case "unavailable":
			return source.failure === "timeout" ? "timeout" : "upstream_unavailable";
		case "missing":
		case "malformed_response":
			return "incomplete";
		case "found":
			throw new TypeError("found response is not a failure");
	}
}

async function readCached(
	options: CaseLawOpinionCacheOptions,
	opinionId: number,
	cluster: QuoteCluster,
) {
	const opinion = await value(() => options.opinions.read({ opinionId }));
	return opinion === undefined || opinion === null || !matchesCluster(opinion, cluster)
		? { kind: "missing" as const }
		: { kind: freshness(opinion, options.now()), opinion };
}

async function waitForCached(
	options: CaseLawOpinionCacheOptions,
	opinionId: number,
	cluster: QuoteCluster,
	expiresAt: string,
): Promise<CachedOpinion | undefined> {
	const deadline = new Date(expiresAt).getTime();
	let delay = INITIAL_DELAY_MS;
	while (Number.isFinite(deadline)) {
		const beforeWait = options.now().getTime();
		const remaining = deadline - beforeWait;
		if (remaining <= 0) return undefined;
		await (options.waitForFill ?? waitForFill)(Math.min(delay, remaining));
		const cached = await readCached(options, opinionId, cluster);
		if (cached.kind !== "missing") return cached.opinion;
		if (options.now().getTime() <= beforeWait) return undefined;
		delay = Math.min(delay * 2, MAX_DELAY_MS);
	}
	return undefined;
}

function indeterminate(reason: FailureReason, retryAfterSeconds?: number) {
	return {
		kind: "indeterminate" as const,
		reason,
		...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
	};
}
async function release(
	options: CaseLawOpinionCacheOptions,
	opinionId: number,
	ownerToken: string,
): Promise<void> {
	await value(() => options.opinions.releaseLease({ opinionId, ownerToken }));
}
function value<Value>(call: () => Promise<Value>): Promise<Value | undefined> {
	return call().catch((error: unknown) => {
		if (error instanceof Error) return undefined;
		throw error;
	});
}
function waitForFill(delayMilliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, delayMilliseconds));
}

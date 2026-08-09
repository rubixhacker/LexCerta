import type { OpinionSourceStore } from "../cache/opinion-source-store.js";
import type { OpinionSourceProvenance } from "../verification/opinion-source-cache.js";
import { selectOpinionText } from "../verification/quote-contract.js";
import type { QuoteCluster } from "../verification/verify-quote.js";
import type { CaseLawRequestFailure } from "./case-law-admission.js";
import type { CourtListenerCaseLawOpinion, CourtListenerCaseLawOutcome } from "./case-law-api.js";
import type { ExecutionFactObserver } from "../telemetry/execution-facts.js";
import {
	type OpinionFailureReason,
	type OpinionResult,
	type UsableCache,
	cached,
	durableWinner,
	fallback,
	found,
	foundSource,
	indeterminate,
	opinionIdFromUrl,
	sourceText,
	waitForWinner,
} from "./case-law-opinion-source-support.js";

export type CachedCaseLawOpinionOptions = {
	readonly executionFacts?: ExecutionFactObserver;
	readonly fetch: (
		url: string,
	) => Promise<
		| CourtListenerCaseLawOutcome<{ readonly opinion: CourtListenerCaseLawOpinion }>
		| CaseLawRequestFailure
		| undefined
	>;
	readonly now: () => Date;
	readonly store: OpinionSourceStore;
	readonly token: () => string;
	readonly waitForFill?: (delayMilliseconds: number) => Promise<void>;
};

export async function readCachedCaseLawOpinion(
	input: { readonly cluster: QuoteCluster; readonly opinionUrl: string },
	options: CachedCaseLawOpinionOptions,
): Promise<OpinionResult> {
	const opinionId = opinionIdFromUrl(input.opinionUrl);
	if (opinionId === undefined) return indeterminate("incomplete");
	const provenance = {
		opinionId,
		clusterId: input.cluster.id,
		canonicalUrl: input.cluster.canonicalUrl,
	};
	const initial = await cached(options, provenance);
	if (initial.kind === "failure") return indeterminate("upstream_unavailable");
	if (initial.kind === "usable" && !initial.decision.requiresRevalidation)
		return found(initial.read, initial.decision.freshness);
	if (initial.kind === "decided" && !initial.decision.requiresRevalidation)
		return indeterminate("incomplete");
	const retained = initial.kind === "usable" ? initial : undefined;
	return acquireAndRead(input, options, provenance, retained);
}

async function acquireAndRead(
	input: { readonly cluster: QuoteCluster; readonly opinionUrl: string },
	options: CachedCaseLawOpinionOptions,
	provenance: OpinionSourceProvenance,
	retained: UsableCache | undefined,
): Promise<OpinionResult> {
	const ownerToken = options.token();
	let lease = await value(() =>
		options.store.acquireLease({ now: options.now(), opinionId: provenance.opinionId, ownerToken }),
	);
	if (lease === undefined) return fallback(retained, "upstream_unavailable");
	while (lease.kind === "held") {
		const waited = await waitForWinner(options, provenance, lease.expiresAt);
		if (waited.kind === "failure") return fallback(retained, "upstream_unavailable");
		if (waited.kind === "usable" && !waited.decision.requiresRevalidation)
			return found(waited.read, waited.decision.freshness);
		if (waited.kind === "decided" && !waited.decision.requiresRevalidation)
			return indeterminate("incomplete");
		lease = await value(() =>
			options.store.acquireLease({
				now: options.now(),
				opinionId: provenance.opinionId,
				ownerToken,
			}),
		);
		if (lease === undefined) return fallback(retained, "upstream_unavailable");
	}
	const rechecked = await cached(options, provenance);
	if (rechecked.kind === "failure") {
		await release(options, provenance.opinionId, ownerToken);
		return indeterminate("upstream_unavailable");
	}
	if (rechecked.kind === "usable" && !rechecked.decision.requiresRevalidation) {
		await release(options, provenance.opinionId, ownerToken);
		return found(rechecked.read, rechecked.decision.freshness);
	}
	if (rechecked.kind === "decided" && !rechecked.decision.requiresRevalidation) {
		await release(options, provenance.opinionId, ownerToken);
		return indeterminate("incomplete");
	}
	if (
		rechecked.kind === "decided" &&
		rechecked.decision.kind === "indeterminate" &&
		rechecked.decision.reason === "stale_negative"
	) {
		const expected = rechecked.read?.state;
		if (expected?.kind !== "negative") {
			await release(options, provenance.opinionId, ownerToken);
			return indeterminate("upstream_unavailable");
		}
		const purged = await value(() =>
			options.store.purgeExpiredNegativeLease({
				expected,
				now: options.now(),
				opinionId: provenance.opinionId,
				ownerToken,
			}),
		);
		if (purged === undefined || purged.kind === "lease_unavailable")
			return indeterminate("upstream_unavailable");
		if (purged.kind === "state_changed") {
			await release(options, provenance.opinionId, ownerToken);
			return durableWinner(options, provenance, retained);
		}
	}
	return fetchAndFill(input, options, provenance, ownerToken, retained);
}

async function fetchAndFill(
	input: { readonly cluster: QuoteCluster; readonly opinionUrl: string },
	options: CachedCaseLawOpinionOptions,
	provenance: OpinionSourceProvenance,
	ownerToken: string,
	retained: UsableCache | undefined,
): Promise<OpinionResult> {
	const source = await options.fetch(input.opinionUrl);
	if (source === undefined)
		return releasedFallback(options, provenance.opinionId, ownerToken, retained, "quota_unknown");
	if (source.kind === "indeterminate")
		return releasedFallback(
			options,
			provenance.opinionId,
			ownerToken,
			retained,
			source.reason,
			source.retryAfterSeconds,
		);
	if (source.kind === "rate_limited")
		return releasedFallback(
			options,
			provenance.opinionId,
			ownerToken,
			retained,
			"rate_limited",
			source.retryAfterSeconds,
		);
	if (source.kind === "unavailable")
		return releasedFallback(
			options,
			provenance.opinionId,
			ownerToken,
			retained,
			source.failure === "timeout" ? "timeout" : "upstream_unavailable",
		);
	if (source.kind === "malformed_response")
		return releasedFallback(options, provenance.opinionId, ownerToken, retained, "incomplete");
	if (
		source.kind === "found" &&
		(source.opinion.id !== provenance.opinionId || source.opinion.clusterId !== input.cluster.id)
	)
		return releasedFallback(options, provenance.opinionId, ownerToken, retained, "incomplete");
	const selected =
		source.kind === "found" ? selectOpinionText(sourceText(source.opinion)) : undefined;
	if (source.kind === "found" && selected === undefined) {
		await release(options, provenance.opinionId, ownerToken);
		return indeterminate("incomplete");
	}
	const observation =
		source.kind === "missing"
			? { kind: "negative" as const, provenance }
			: selected === undefined
				? { kind: "negative" as const, provenance }
				: {
						kind: "positive" as const,
						provenance,
						representation: selected.representation,
						sourceText: selected.content,
					};
	const observedAt = options.now();
	const filled = await value(() =>
		options.store.fillLease({ now: observedAt, ownerToken, observation }),
	);
	if (filled?.kind !== "stored")
		return durableWinner(options, provenance, retained, observation.kind === "negative");
	if (filled.state.kind !== "positive")
		return indeterminate(
			filled.state.kind === "reversal_pending" ? "source_changed" : "incomplete",
		);
	if (selected === undefined) return indeterminate("incomplete");
	return foundSource(
		provenance,
		selected.representation,
		selected.content,
		filled.state.positive.retrievedAt,
		"fresh",
	);
}

async function releasedFallback(
	options: CachedCaseLawOpinionOptions,
	opinionId: number,
	ownerToken: string,
	retained: UsableCache | undefined,
	reason: OpinionFailureReason,
	retryAfterSeconds?: number,
): Promise<OpinionResult> {
	await release(options, opinionId, ownerToken);
	return fallback(retained, reason, retryAfterSeconds);
}
async function release(
	options: CachedCaseLawOpinionOptions,
	opinionId: number,
	ownerToken: string,
): Promise<void> {
	await value(() => options.store.releaseLease({ now: options.now(), opinionId, ownerToken }));
}
function value<Value>(call: () => Promise<Value>): Promise<Value | undefined> {
	return call().catch((error: unknown) => {
		if (error instanceof Error) return undefined;
		throw error;
	});
}

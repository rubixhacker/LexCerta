import type {
	CitationObservationStore,
	LeaseFillResult,
	StoredCitationObservation,
} from "../cache/citation-observation-store.js";
import {
	readCitationSourceCache,
	type CitationSourceCacheDecision,
	type CitationSourceObservation,
} from "./citation-source-cache.js";
import type {
	CitationVerificationGateway,
	CitationVerificationObservation,
} from "./verify-citation.js";

const WAITER_INITIAL_RECHECK_DELAY_MS = 50;
const WAITER_MAX_RECHECK_DELAY_MS = 1_000;

export type CachedCitationGatewayOptions = {
	readonly now: () => Date;
	readonly ownerToken: () => string;
	readonly store: CitationObservationStore;
	readonly upstream: CitationVerificationGateway;
	readonly waitForFill?: (delayMilliseconds: number) => Promise<void>;
};

export function createCachedCitationGateway(
	options: CachedCitationGatewayOptions,
): CitationVerificationGateway {
	return {
		async lookup(query): Promise<CitationVerificationObservation> {
			let retainedFallback: CitationVerificationObservation | undefined;
			try {
				const cached = await options.store.read({ normalizedCitation: query.normalizedCitation });
				const now = options.now();
				const decision = readCitationSourceCache({ state: cached ?? { kind: "empty" }, now });
				retainedFallback = retainedObservation(decision);
				if (!requiresRevalidation(decision)) return observationFor(decision);

				const ownerToken = options.ownerToken();
				const lease = await options.store.acquireLease({
					normalizedCitation: query.normalizedCitation,
					ownerToken,
					now,
				});
				if (lease.kind === "held") {
					const deadline = new Date(lease.expiresAt).getTime();
					let delayMilliseconds = WAITER_INITIAL_RECHECK_DELAY_MS;
					while (Number.isFinite(deadline)) {
						const beforeWait = options.now().getTime();
						const remainingMilliseconds = deadline - beforeWait;
						if (remainingMilliseconds <= 0) break;
						await (options.waitForFill ?? waitForFill)(
							Math.min(delayMilliseconds, remainingMilliseconds),
						);
						const rechecked = await options.store.read({
							normalizedCitation: query.normalizedCitation,
						});
						const recheckedDecision = readCitationSourceCache({
							state: rechecked ?? { kind: "empty" },
							now: options.now(),
						});
						const observation = waiterObservation(rechecked, options.now(), recheckedDecision);
						if (observation.kind !== "indeterminate") return observation;
						if (observation.reason === "source_changed") return observation;
						if (options.now().getTime() <= beforeWait) break;
						delayMilliseconds = Math.min(delayMilliseconds * 2, WAITER_MAX_RECHECK_DELAY_MS);
					}
					return waiterObservation(null, options.now(), decision);
				}
				const afterLease = await options.store.read({
					normalizedCitation: query.normalizedCitation,
				});
				let current = readCitationSourceCache({
					state: afterLease ?? { kind: "empty" },
					now: options.now(),
				});
				retainedFallback = retainedObservation(current) ?? retainedFallback;
				if (!requiresRevalidation(current)) {
					await options.store.releaseLease({
						normalizedCitation: query.normalizedCitation,
						ownerToken,
					});
					return observationFor(current);
				}
				if (current.kind === "indeterminate" && current.reason === "stale_negative") {
					const staleNegative = requireNegative(afterLease);
					const purge = await options.store.purgeExpiredNegativeLease({
						normalizedCitation: query.normalizedCitation,
						ownerToken,
						now: options.now(),
						expected: staleNegative,
					});
					if (purge.kind === "lease_unavailable") return retainedFallback ?? unavailable();
					if (purge.kind === "state_changed") {
						const changed = await options.store.read({
							normalizedCitation: query.normalizedCitation,
						});
						current = readCitationSourceCache({
							state: changed ?? { kind: "empty" },
							now: options.now(),
						});
						retainedFallback = retainedObservation(current) ?? retainedFallback;
						if (!requiresRevalidation(current)) {
							await options.store.releaseLease({
								normalizedCitation: query.normalizedCitation,
								ownerToken,
							});
							return observationFor(current);
						}
						if (current.kind === "indeterminate" && current.reason === "stale_negative") {
							await options.store.releaseLease({
								normalizedCitation: query.normalizedCitation,
								ownerToken,
							});
							return unavailable();
						}
					} else {
						current = readCitationSourceCache({
							state: purge.observation ?? { kind: "empty" },
							now: options.now(),
						});
						retainedFallback = retainedObservation(current) ?? retainedFallback;
					}
				}

				const upstream = await options.upstream.lookup(query);
				if (upstream.kind === "indeterminate") {
					await options.store.releaseLease({
						normalizedCitation: query.normalizedCitation,
						ownerToken,
					});
					return fallbackObservation(current, upstream);
				}
				const fill = await options.store.fillLease({
					normalizedCitation: query.normalizedCitation,
					ownerToken,
					now: options.now(),
					observation: sourceObservation(upstream),
				});
				return filledObservation(fill, options.now(), retainedFallback);
			} catch (error) {
				if (error instanceof Error) return retainedFallback ?? unavailable();
				throw error;
			}
		},
	};
}

function requireNegative(
	state: StoredCitationObservation | null,
): Extract<StoredCitationObservation, { readonly kind: "negative" }> {
	if (state?.kind === "negative") return state;
	throw new TypeError("stale negative decision requires a stored negative state");
}

function waiterObservation(
	state: StoredCitationObservation | null,
	now: Date,
	prior: CitationSourceCacheDecision,
): CitationVerificationObservation {
	const decision = readCitationSourceCache({ state: state ?? { kind: "empty" }, now });
	return requiresRevalidation(decision)
		? fallbackObservation(prior, unavailable())
		: observationFor(decision);
}

function filledObservation(
	fill: LeaseFillResult,
	now: Date,
	retainedFallback: CitationVerificationObservation | undefined,
): CitationVerificationObservation {
	if (fill.kind === "lease_unavailable") return retainedFallback ?? unavailable();
	return observationFor(readCitationSourceCache({ state: fill.observation, now }));
}

function fallbackObservation(
	decision: CitationSourceCacheDecision,
	upstream: CitationVerificationObservation,
): CitationVerificationObservation {
	return retainedObservation(decision) ?? upstream;
}

function retainedObservation(
	decision: CitationSourceCacheDecision,
): CitationVerificationObservation | undefined {
	if (decision.kind === "verified" && decision.freshness === "stale")
		return observationFor(decision);
	if (decision.kind === "indeterminate" && decision.reason === "source_changed") {
		return { kind: "indeterminate", reason: "source_changed" };
	}
	return undefined;
}

function observationFor(decision: CitationSourceCacheDecision): CitationVerificationObservation {
	switch (decision.kind) {
		case "verified":
			return {
				kind: "verified",
				cluster: decision.positive.cluster,
				freshness: decision.freshness,
				retrievedAt: decision.positive.retrievedAt.toISOString(),
			};
		case "not_found":
			return { kind: "not_found", retrievedAt: decision.negative.retrievedAt.toISOString() };
		case "indeterminate":
			switch (decision.reason) {
				case "source_changed":
					return { kind: "indeterminate", reason: "source_changed" };
				case "cache_miss":
				case "stale_negative":
					return unavailable();
				default:
					return assertNever(decision.reason);
			}
		default:
			return assertNever(decision);
	}
}

function requiresRevalidation(decision: CitationSourceCacheDecision): boolean {
	switch (decision.kind) {
		case "verified":
			return decision.requiresRevalidation;
		case "not_found":
			return false;
		case "indeterminate":
			return true;
		default:
			return assertNever(decision);
	}
}

function sourceObservation(
	observation: Exclude<CitationVerificationObservation, { readonly kind: "indeterminate" }>,
): CitationSourceObservation {
	switch (observation.kind) {
		case "verified":
			return { kind: "positive", cluster: observation.cluster };
		case "not_found":
			return { kind: "negative" };
		default:
			return assertNever(observation);
	}
}

function unavailable(): CitationVerificationObservation {
	return { kind: "indeterminate", reason: "upstream_unavailable" };
}

function waitForFill(delayMilliseconds: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, delayMilliseconds);
	});
}

function assertNever(value: never): never {
	throw new TypeError(`Unexpected cached citation value: ${String(value)}`);
}

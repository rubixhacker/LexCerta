import type { OpinionTextRepresentation } from "./quote-contract.js";

export const DEFAULT_OPINION_SOURCE_CACHE_POLICY = {
	positiveFreshnessMs: 30 * 24 * 60 * 60 * 1_000,
	negativeFreshnessMs: 24 * 60 * 60 * 1_000,
	reversalConfirmationMs: 24 * 60 * 60 * 1_000,
} as const;

export type OpinionSourceCachePolicy = {
	readonly positiveFreshnessMs: number;
	readonly negativeFreshnessMs: number;
	readonly reversalConfirmationMs: number;
};

export type OpinionSourceRepresentation = OpinionTextRepresentation;

export type OpinionSourceProvenance = {
	readonly opinionId: number;
	readonly clusterId: number;
	readonly canonicalUrl: string;
};

export type PositiveOpinionSourceObservation = {
	readonly kind: "positive";
	readonly provenance: OpinionSourceProvenance;
	readonly representation: OpinionSourceRepresentation;
	readonly contentHash: string;
	readonly objectKey: string;
	readonly retrievedAt: Date;
};

export type NegativeOpinionSourceObservation = {
	readonly kind: "negative";
	readonly provenance: OpinionSourceProvenance;
	readonly retrievedAt: Date;
};

export type OpinionSourceObservation =
	| Omit<PositiveOpinionSourceObservation, "retrievedAt">
	| Omit<NegativeOpinionSourceObservation, "retrievedAt">;

export type OpinionSourceCacheState =
	| { readonly kind: "empty" }
	| { readonly kind: "positive"; readonly positive: PositiveOpinionSourceObservation }
	| {
			readonly kind: "negative";
			readonly negative: NegativeOpinionSourceObservation;
			readonly superseded: PositiveOpinionSourceObservation | null;
	  }
	| {
			readonly kind: "reversal_pending";
			readonly superseded: PositiveOpinionSourceObservation;
			readonly firstNegative: NegativeOpinionSourceObservation;
	  };

export type OpinionSourceCacheDecision =
	| {
			readonly kind: "available";
			readonly freshness: "fresh";
			readonly requiresRevalidation: false;
			readonly positive: PositiveOpinionSourceObservation;
	  }
	| {
			readonly kind: "available";
			readonly freshness: "stale";
			readonly requiresRevalidation: true;
			readonly positive: PositiveOpinionSourceObservation;
	  }
	| {
			readonly kind: "source_unavailable";
			readonly requiresRevalidation: false;
			readonly negative: NegativeOpinionSourceObservation;
	  }
	| {
			readonly kind: "indeterminate";
			readonly reason: "cache_miss" | "stale_negative" | "source_changed";
			readonly requiresRevalidation: true;
	  };

export type OpinionSourceCacheRead = {
	readonly state: OpinionSourceCacheState;
	readonly now: Date;
	readonly policy?: OpinionSourceCachePolicy;
};

export type OpinionSourceObservationRecord = {
	readonly state: OpinionSourceCacheState;
	readonly observation: OpinionSourceObservation;
	readonly now: Date;
	readonly policy?: OpinionSourceCachePolicy;
};

export type OpinionSourceNegativePurge = OpinionSourceCacheRead;

export function initialOpinionSourceCacheState(): OpinionSourceCacheState {
	return { kind: "empty" };
}

export function readOpinionSourceCache(input: OpinionSourceCacheRead): OpinionSourceCacheDecision {
	const policy = input.policy ?? DEFAULT_OPINION_SOURCE_CACHE_POLICY;
	switch (input.state.kind) {
		case "empty":
			return refreshRequired("cache_miss");
		case "positive":
			return positiveDecision(input.state.positive, input.now, policy);
		case "negative":
			return isFresh(input.state.negative.retrievedAt, input.now, policy.negativeFreshnessMs)
				? {
						kind: "source_unavailable",
						requiresRevalidation: false,
						negative: input.state.negative,
					}
				: refreshRequired("stale_negative");
		case "reversal_pending":
			return refreshRequired("source_changed");
		default:
			return assertNever(input.state);
	}
}

export function recordOpinionSourceObservation(
	input: OpinionSourceObservationRecord,
): OpinionSourceCacheState {
	const policy = input.policy ?? DEFAULT_OPINION_SOURCE_CACHE_POLICY;
	const observation = withRetrievedAt(input.observation, input.now);
	switch (input.state.kind) {
		case "empty":
			return stateFor(observation);
		case "positive":
			return observation.kind === "positive"
				? stateFor(observation)
				: {
						kind: "reversal_pending",
						superseded: input.state.positive,
						firstNegative: observation,
					};
		case "negative":
			return observation.kind === "positive"
				? stateFor(observation)
				: { kind: "negative", negative: observation, superseded: input.state.superseded };
		case "reversal_pending":
			switch (observation.kind) {
				case "positive":
					return stateFor(observation);
				case "negative":
					return isFresh(
						input.state.firstNegative.retrievedAt,
						input.now,
						policy.reversalConfirmationMs,
					)
						? input.state
						: {
								kind: "negative",
								negative: observation,
								superseded: input.state.superseded,
							};
				default:
					return assertNever(observation);
			}
		default:
			return assertNever(input.state);
	}
}

export function purgeExpiredOpinionNegative(
	input: OpinionSourceNegativePurge,
): OpinionSourceCacheState {
	const policy = input.policy ?? DEFAULT_OPINION_SOURCE_CACHE_POLICY;
	if (
		input.state.kind !== "negative" ||
		isFresh(input.state.negative.retrievedAt, input.now, policy.negativeFreshnessMs)
	)
		return input.state;
	return input.state.superseded === null
		? initialOpinionSourceCacheState()
		: {
				kind: "reversal_pending",
				superseded: input.state.superseded,
				firstNegative: input.state.negative,
			};
}

function withRetrievedAt(
	observation: OpinionSourceObservation,
	now: Date,
): PositiveOpinionSourceObservation | NegativeOpinionSourceObservation {
	switch (observation.kind) {
		case "positive":
			return { ...observation, retrievedAt: now };
		case "negative":
			return { ...observation, retrievedAt: now };
		default:
			return assertNever(observation);
	}
}

function stateFor(
	observation: PositiveOpinionSourceObservation | NegativeOpinionSourceObservation,
): OpinionSourceCacheState {
	switch (observation.kind) {
		case "positive":
			return { kind: "positive", positive: observation };
		case "negative":
			return { kind: "negative", negative: observation, superseded: null };
		default:
			return assertNever(observation);
	}
}

function positiveDecision(
	positive: PositiveOpinionSourceObservation,
	now: Date,
	policy: OpinionSourceCachePolicy,
): OpinionSourceCacheDecision {
	return isFresh(positive.retrievedAt, now, policy.positiveFreshnessMs)
		? { kind: "available", freshness: "fresh", requiresRevalidation: false, positive }
		: { kind: "available", freshness: "stale", requiresRevalidation: true, positive };
}

function refreshRequired(
	reason: Extract<OpinionSourceCacheDecision, { readonly kind: "indeterminate" }>["reason"],
): OpinionSourceCacheDecision {
	return { kind: "indeterminate", reason, requiresRevalidation: true };
}

function isFresh(retrievedAt: Date, now: Date, freshnessMs: number): boolean {
	return now.getTime() - retrievedAt.getTime() < freshnessMs;
}

function assertNever(value: never): never {
	throw new TypeError(`Unexpected opinion source cache value: ${JSON.stringify(value)}`);
}

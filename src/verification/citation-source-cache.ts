export const DEFAULT_CITATION_SOURCE_CACHE_POLICY = {
	positiveFreshnessMs: 30 * 24 * 60 * 60 * 1_000,
	negativeFreshnessMs: 24 * 60 * 60 * 1_000,
	reversalConfirmationMs: 24 * 60 * 60 * 1_000,
} as const;

export type CitationSourceCachePolicy = {
	readonly positiveFreshnessMs: number;
	readonly negativeFreshnessMs: number;
	readonly reversalConfirmationMs: number;
};

export type CitationSourceCluster = {
	readonly id: number;
	readonly canonicalUrl: string;
};

export type PositiveCitationObservation = {
	readonly kind: "positive";
	readonly cluster: CitationSourceCluster;
	readonly retrievedAt: Date;
};

export type NegativeCitationObservation = {
	readonly kind: "negative";
	readonly retrievedAt: Date;
};

export type CitationSourceObservation =
	| Omit<PositiveCitationObservation, "retrievedAt">
	| Omit<NegativeCitationObservation, "retrievedAt">;

export type CitationSourceCacheState =
	| { readonly kind: "empty" }
	| { readonly kind: "positive"; readonly positive: PositiveCitationObservation }
	| {
			readonly kind: "negative";
			readonly negative: NegativeCitationObservation;
			readonly superseded: PositiveCitationObservation | null;
	  }
	| {
			readonly kind: "reversal_pending";
			readonly superseded: PositiveCitationObservation;
			readonly firstNegative: NegativeCitationObservation;
	  };

export type CitationSourceCacheDecision =
	| {
			readonly kind: "verified";
			readonly freshness: "fresh" | "stale";
			readonly requiresRevalidation: boolean;
			readonly positive: PositiveCitationObservation;
	  }
	| { readonly kind: "not_found"; readonly negative: NegativeCitationObservation }
	| {
			readonly kind: "indeterminate";
			readonly reason: "cache_miss" | "stale_negative" | "source_changed";
			readonly requiresRevalidation: true;
	  };

export type CitationSourceCacheRead = {
	readonly state: CitationSourceCacheState;
	readonly now: Date;
	readonly policy?: CitationSourceCachePolicy;
};

export type CitationSourceObservationRecord = {
	readonly state: CitationSourceCacheState;
	readonly observation: CitationSourceObservation;
	readonly now: Date;
	readonly policy?: CitationSourceCachePolicy;
};

export function initialCitationSourceCacheState(): CitationSourceCacheState {
	return { kind: "empty" };
}

export function readCitationSourceCache(
	input: CitationSourceCacheRead,
): CitationSourceCacheDecision {
	const policy = input.policy ?? DEFAULT_CITATION_SOURCE_CACHE_POLICY;
	switch (input.state.kind) {
		case "empty":
			return refreshRequired("cache_miss");
		case "positive":
			return positiveDecision(input.state.positive, input.now, policy);
		case "negative":
			return isFresh(input.state.negative.retrievedAt, input.now, policy.negativeFreshnessMs)
				? { kind: "not_found", negative: input.state.negative }
				: refreshRequired("stale_negative");
		case "reversal_pending":
			return refreshRequired("source_changed");
		default:
			return assertNever(input.state);
	}
}

export function recordCitationSourceObservation(
	input: CitationSourceObservationRecord,
): CitationSourceCacheState {
	const policy = input.policy ?? DEFAULT_CITATION_SOURCE_CACHE_POLICY;
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

function withRetrievedAt(
	observation: CitationSourceObservation,
	now: Date,
): PositiveCitationObservation | NegativeCitationObservation {
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
	observation: PositiveCitationObservation | NegativeCitationObservation,
): CitationSourceCacheState {
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
	positive: PositiveCitationObservation,
	now: Date,
	policy: CitationSourceCachePolicy,
): CitationSourceCacheDecision {
	const freshness = isFresh(positive.retrievedAt, now, policy.positiveFreshnessMs)
		? "fresh"
		: "stale";
	return {
		kind: "verified",
		freshness,
		requiresRevalidation: freshness === "stale",
		positive,
	};
}

function refreshRequired(
	reason: Extract<CitationSourceCacheDecision, { readonly kind: "indeterminate" }>["reason"],
): CitationSourceCacheDecision {
	return { kind: "indeterminate", reason, requiresRevalidation: true };
}

function isFresh(retrievedAt: Date, now: Date, freshnessMs: number): boolean {
	return now.getTime() - retrievedAt.getTime() < freshnessMs;
}

function assertNever(value: never): never {
	throw new TypeError(`Unexpected citation source-cache value: ${String(value)}`);
}

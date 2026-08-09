import type { CourtListenerOutcome } from "../courtlistener/budget.js";
import type { CitationSourceCacheDecision } from "../verification/citation-source-cache.js";
import type { OpinionSourceCacheDecision } from "../verification/opinion-source-cache.js";
import type {
	TelemetryCacheStatus,
	TelemetryCircuitStatus,
	TelemetryFreshnessStatus,
	TelemetryUpstreamStatus,
} from "./contract.js";

export type ExecutionFacts = {
	readonly cacheStatus: TelemetryCacheStatus;
	readonly circuitStatus: TelemetryCircuitStatus;
	readonly freshness: TelemetryFreshnessStatus;
	readonly upstreamStatus: TelemetryUpstreamStatus;
};

export type ExecutionFact =
	| {
			readonly kind: "cache";
			readonly status: "hit";
			readonly freshness: "fresh" | "stale";
	  }
	| {
			readonly kind: "cache";
			readonly status: "miss";
			readonly freshness: "not_applicable";
	  }
	| {
			readonly kind: "cache";
			readonly status: "source_changed";
			readonly freshness: "source_changed";
	  }
	| {
			readonly kind: "circuit";
			readonly status: Exclude<TelemetryCircuitStatus, "not_called">;
	  }
	| {
			readonly kind: "upstream";
			readonly status: Exclude<TelemetryUpstreamStatus, "not_called">;
	  };

export interface ExecutionFactObserver {
	readonly observe: (fact: ExecutionFact) => void;
}

export type ExecutionFactCollector = ExecutionFactObserver & {
	readonly snapshot: () => ExecutionFacts;
};

const INITIAL_EXECUTION_FACTS = {
	cacheStatus: "not_used",
	circuitStatus: "not_called",
	freshness: "not_applicable",
	upstreamStatus: "not_called",
} as const satisfies ExecutionFacts;

export function createExecutionFactCollector(): ExecutionFactCollector {
	let facts: ExecutionFacts = INITIAL_EXECUTION_FACTS;
	return {
		observe(fact) {
			switch (fact.kind) {
				case "cache":
					facts = recordCacheFact(facts, fact);
					return;
				case "circuit":
					facts = { ...facts, circuitStatus: fact.status };
					return;
				case "upstream":
					facts = { ...facts, upstreamStatus: fact.status };
					return;
				default:
					return assertNever(fact);
			}
		},
		snapshot: () => facts,
	};
}

function recordCacheFact(
	facts: ExecutionFacts,
	fact: Extract<ExecutionFact, { readonly kind: "cache" }>,
): ExecutionFacts {
	if (facts.cacheStatus === "source_changed") return facts;
	if (fact.status === "source_changed")
		return { ...facts, cacheStatus: fact.status, freshness: fact.freshness };
	if (facts.cacheStatus === "miss") return facts;
	return { ...facts, cacheStatus: fact.status, freshness: fact.freshness };
}

export function observeCitationCacheDecision(
	observer: ExecutionFactObserver | undefined,
	decision: CitationSourceCacheDecision,
): void {
	switch (decision.kind) {
		case "verified":
			observeCache(observer, "hit", decision.freshness);
			return;
		case "not_found":
			observeCache(observer, "hit", "fresh");
			return;
		case "indeterminate":
			observeCache(
				observer,
				decision.reason === "source_changed" ? "source_changed" : "miss",
				decision.reason === "source_changed" ? "source_changed" : "not_applicable",
			);
			return;
		default:
			assertNever(decision);
	}
}

export function observeOpinionCacheDecision(
	observer: ExecutionFactObserver | undefined,
	decision: OpinionSourceCacheDecision,
): void {
	switch (decision.kind) {
		case "available":
			observeCache(observer, "hit", decision.freshness);
			return;
		case "source_unavailable":
			observeCache(observer, "hit", "fresh");
			return;
		case "indeterminate":
			observeCache(
				observer,
				decision.reason === "source_changed" ? "source_changed" : "miss",
				decision.reason === "source_changed" ? "source_changed" : "not_applicable",
			);
			return;
		default:
			assertNever(decision);
	}
}

export function observeCircuitStatus(
	observer: ExecutionFactObserver | undefined,
	status: "closed" | "open" | "half_open",
): void {
	observer?.observe({ kind: "circuit", status });
}

export function observeCourtListenerOutcome(
	observer: ExecutionFactObserver | undefined,
	outcome: CourtListenerOutcome,
): void {
	switch (outcome.kind) {
		case "success":
			observer?.observe({ kind: "upstream", status: "success" });
			return;
		case "timeout":
			observer?.observe({ kind: "upstream", status: "timeout" });
			return;
		case "server_error":
			observer?.observe({ kind: "upstream", status: "server_error" });
			return;
		case "transport_error":
			observer?.observe({ kind: "upstream", status: "unavailable" });
			return;
		case "malformed_response":
			observer?.observe({ kind: "upstream", status: "malformed_response" });
			return;
		case "rate_limited":
			observer?.observe({ kind: "upstream", status: "rate_limited" });
			return;
		default:
			assertNever(outcome);
	}
}

function observeCache(
	observer: ExecutionFactObserver | undefined,
	status: "hit" | "miss" | "source_changed",
	freshness: "fresh" | "stale" | "source_changed" | "not_applicable",
): void {
	switch (status) {
		case "hit":
			if (freshness === "fresh" || freshness === "stale") {
				observer?.observe({ kind: "cache", status, freshness });
				return;
			}
			throw new TypeError("cache hits require evidence freshness");
		case "miss":
			if (freshness === "not_applicable") {
				observer?.observe({ kind: "cache", status, freshness });
				return;
			}
			throw new TypeError("cache misses cannot have evidence freshness");
		case "source_changed":
			if (freshness === "source_changed") {
				observer?.observe({ kind: "cache", status, freshness });
				return;
			}
			throw new TypeError("source changes require source_changed freshness");
		default:
			assertNever(status);
	}
}

function assertNever(value: never): never {
	throw new TypeError(`Unexpected execution fact: ${String(value)}`);
}

import {
	observeCircuitStatus,
	observeCourtListenerOutcome,
	type ExecutionFactObserver,
} from "../telemetry/execution-facts.js";
import type * as Verification from "../verification/verify-citation.js";
import type { CitationLookupOutcome, CourtListenerApi } from "./api.js";
import type { BudgetDecision, CourtListenerOutcome } from "./budget.js";
import type { CourtListenerCoordinatorRpc } from "./coordinator.js";
import { synchronizeCourtListenerQuota } from "./quota-sync.js";

const FALLBACK_RETRY_SECONDS = 15 * 60;
const OUTCOME_FOR_FAILURE = {
	server: { kind: "server_error" },
	timeout: { kind: "timeout" },
	transport: { kind: "transport_error" },
} satisfies Record<"server" | "timeout" | "transport", CourtListenerOutcome>;

export type CourtListenerCitationGatewayOptions = {
	readonly api: CourtListenerApi;
	readonly coordinator: CourtListenerCoordinatorRpc;
	readonly executionFacts?: ExecutionFactObserver;
	readonly now: () => Date;
	readonly token: () => string;
};

export function createCourtListenerCitationGateway(
	options: CourtListenerCitationGatewayOptions,
): Verification.CitationVerificationGateway {
	return {
		async lookup(query) {
			const admission = await value(() =>
				options.coordinator.admit({
					endpoint: "citation",
					now: options.now(),
					reservationToken: options.token(),
				}),
			);
			if (admission === null) {
				options.executionFacts?.observe({ kind: "upstream", status: "quota_unknown" });
				return indeterminate("quota_unknown");
			}
			return admit(admission, query, options, true);
		},
	};
}

async function admit(
	admission: BudgetDecision,
	query: Verification.CitationLookup,
	options: CourtListenerCitationGatewayOptions,
	maySynchronize: boolean,
): Promise<Verification.CitationVerificationObservation> {
	observeCircuitStatus(options.executionFacts, admission.state.circuits.citation.kind);
	switch (admission.kind) {
		case "reserved":
			return lookupReserved(admission.token, query, options);
		case "sync_required":
			if (maySynchronize) return synchronizeAndAdmit(query, options);
			options.executionFacts?.observe({ kind: "upstream", status: "quota_unknown" });
			return indeterminate("quota_unknown");
		case "quota_limited":
			options.executionFacts?.observe({ kind: "upstream", status: "quota_limited" });
			return delayed("rate_limited", options.now(), admission.retryAt);
		case "circuit_open":
			return delayed("circuit_open", options.now(), admission.retryAt);
		case "sync_in_progress":
		case "sync_unavailable":
		case "quota_exhausted":
			options.executionFacts?.observe({ kind: "upstream", status: "quota_limited" });
			return indeterminate("quota_unknown");
		case "probe_in_flight":
		case "reservation_conflict":
		case "reservation_capacity_exhausted":
			options.executionFacts?.observe({ kind: "upstream", status: "quota_unknown" });
			return indeterminate("quota_unknown");
		default:
			return assertNever(admission);
	}
}

async function synchronizeAndAdmit(
	query: Verification.CitationLookup,
	options: CourtListenerCitationGatewayOptions,
): Promise<Verification.CitationVerificationObservation> {
	const sync = await synchronizeCourtListenerQuota(options);
	if (sync.kind === "rate_limited") {
		options.executionFacts?.observe({ kind: "upstream", status: "rate_limited" });
		return delayed("rate_limited", options.now(), sync.retryAt);
	}
	if (sync.kind === "failed") {
		options.executionFacts?.observe({ kind: "upstream", status: "quota_unknown" });
		return indeterminate("quota_unknown");
	}
	const admission = await value(() =>
		options.coordinator.admit({
			endpoint: "citation",
			now: options.now(),
			reservationToken: options.token(),
		}),
	);
	if (admission === null) {
		options.executionFacts?.observe({ kind: "upstream", status: "quota_unknown" });
		return indeterminate("quota_unknown");
	}
	return admit(admission, query, options, false);
}

async function lookupReserved(
	reservationToken: string,
	query: Verification.CitationLookup,
	options: CourtListenerCitationGatewayOptions,
): Promise<Verification.CitationVerificationObservation> {
	const incomplete = indeterminate("incomplete");
	const unavailable = indeterminate("upstream_unavailable");
	const source = await value(() =>
		options.api.lookupCitation({ normalized: query.normalizedCitation }),
	);
	if (source === null)
		return record(reservationToken, { kind: "transport_error" }, unavailable, options);
	const retrievedAt = options.now().toISOString();
	switch (source.kind) {
		case "matched": {
			const cluster = trustedCluster(source);
			return cluster === null
				? record(reservationToken, { kind: "malformed_response" }, incomplete, options)
				: record(
						reservationToken,
						{ kind: "success" },
						{ kind: "verified", cluster, freshness: "fresh", retrievedAt },
						options,
					);
		}
		case "absent":
			return record(
				reservationToken,
				{ kind: "success" },
				{ kind: "not_found", retrievedAt },
				options,
			);
		case "ambiguous":
		case "unknown_reporter":
		case "item_cap":
		case "malformed_response":
			return record(reservationToken, { kind: "malformed_response" }, incomplete, options);
		case "rate_limited": {
			const now = options.now();
			const retryAt = retryDeadline(now, source.retryAfterSeconds);
			const observation = delayed("rate_limited", now, retryAt);
			const recorded = await record(
				reservationToken,
				{ kind: "rate_limited", retryAt },
				observation,
				options,
			);
			if (recorded.kind === "indeterminate" && recorded.reason === "quota_unknown") return recorded;
			const sync = await synchronizeCourtListenerQuota(options);
			return sync.kind === "rate_limited"
				? delayed("rate_limited", now, sync.retryAt)
				: observation;
		}
		case "unavailable":
			return record(
				reservationToken,
				OUTCOME_FOR_FAILURE[source.failure],
				source.failure === "timeout" ? indeterminate("timeout") : unavailable,
				options,
			);
		default:
			return assertNever(source);
	}
}

async function record(
	reservationToken: string,
	outcome: CourtListenerOutcome,
	observation: Verification.CitationVerificationObservation,
	options: CourtListenerCitationGatewayOptions,
): Promise<Verification.CitationVerificationObservation> {
	observeCourtListenerOutcome(options.executionFacts, outcome);
	const recorded = await value(() =>
		options.coordinator.recordOutcome({
			endpoint: "citation",
			now: options.now(),
			outcome,
			reservationToken,
		}),
	);
	return recorded?.kind === "recorded" ? observation : indeterminate("quota_unknown");
}

function trustedCluster(source: Extract<CitationLookupOutcome, { readonly kind: "matched" }>) {
	if (source.clusters.length !== 1) return null;
	const [cluster] = source.clusters;
	if (cluster === undefined || !Number.isSafeInteger(cluster.id) || cluster.id <= 0) return null;
	try {
		const url = new URL(cluster.canonicalUrl);
		return url.protocol === "https:" &&
			(url.hostname === "courtlistener.com" || url.hostname === "www.courtlistener.com")
			? cluster
			: null;
	} catch {
		return null;
	}
}

function indeterminate(
	reason: "incomplete" | "quota_unknown" | "timeout" | "upstream_unavailable",
): Verification.CitationVerificationObservation {
	return { kind: "indeterminate", reason };
}
function delayed(
	reason: "circuit_open" | "rate_limited",
	now: Date,
	retryAt: Date,
): Verification.CitationVerificationObservation {
	return { kind: "indeterminate", reason, retryAfterSeconds: retrySeconds(now, retryAt) };
}
function retrySeconds(now: Date, retryAt: Date): number {
	return Math.max(1, Math.ceil((retryAt.getTime() - now.getTime()) / 1_000));
}
function retryDeadline(now: Date, retryAfterSeconds: number | undefined): Date {
	return new Date(now.getTime() + (retryAfterSeconds ?? FALLBACK_RETRY_SECONDS) * 1_000);
}
function value<Value>(call: () => Promise<Value>): Promise<Value | null> {
	return call().catch((error: unknown) => {
		if (error instanceof Error) return null;
		throw error;
	});
}
function assertNever(value: never): never {
	throw new TypeError(`Unexpected CourtListener outcome: ${String(value)}`);
}

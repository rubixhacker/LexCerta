import type { CourtListenerApi } from "./api.js";
import type { BudgetDecision } from "./budget-contract.js";
import type { CourtListenerOutcome } from "./budget.js";
import type { CourtListenerCaseLawOutcome } from "./case-law-api.js";
import type { CourtListenerCoordinatorRpc } from "./coordinator.js";
import { synchronizeCourtListenerQuota } from "./quota-sync.js";

export type CaseLawAdmissionOptions = {
	readonly coordinator: CourtListenerCoordinatorRpc;
	readonly now: () => Date;
	readonly quotaApi: Pick<CourtListenerApi, "getUsage">;
	readonly token: () => string;
};

export type CaseLawFailureReason =
	| "circuit_open"
	| "quota_unknown"
	| "rate_limited"
	| "upstream_unavailable";

export type CaseLawRequestFailure = {
	readonly kind: "indeterminate";
	readonly reason: CaseLawFailureReason;
	readonly retryAfterSeconds?: number;
};

export type CaseLawRequestResult<Value extends object> =
	| { readonly kind: "source"; readonly source: CourtListenerCaseLawOutcome<Value> }
	| CaseLawRequestFailure;

export async function requestCaseLaw<Value extends object>(
	options: CaseLawAdmissionOptions,
	request: () => Promise<CourtListenerCaseLawOutcome<Value>>,
): Promise<CaseLawRequestResult<Value>> {
	const initial = await value(() =>
		options.coordinator.admit({
			endpoint: "case_law",
			now: options.now(),
			reservationToken: options.token(),
		}),
	);
	return initial === undefined
		? indeterminate("quota_unknown")
		: decide(initial, options, request, true);
}

async function decide<Value extends object>(
	decision: BudgetDecision,
	options: CaseLawAdmissionOptions,
	request: () => Promise<CourtListenerCaseLawOutcome<Value>>,
	maySynchronize: boolean,
): Promise<CaseLawRequestResult<Value>> {
	switch (decision.kind) {
		case "reserved":
			return requestReserved(decision.token, options, request);
		case "sync_required":
			return maySynchronize
				? synchronizeAndReadmit(options, request)
				: indeterminate("quota_unknown");
		case "quota_limited":
			return delayed("rate_limited", options.now(), decision.retryAt);
		case "circuit_open":
			return delayed("circuit_open", options.now(), decision.retryAt);
		case "sync_in_progress":
		case "sync_unavailable":
		case "quota_exhausted":
		case "probe_in_flight":
		case "reservation_conflict":
		case "reservation_capacity_exhausted":
			return indeterminate("quota_unknown");
		default:
			return assertNever(decision);
	}
}

async function synchronizeAndReadmit<Value extends object>(
	options: CaseLawAdmissionOptions,
	request: () => Promise<CourtListenerCaseLawOutcome<Value>>,
): Promise<CaseLawRequestResult<Value>> {
	const sync = await synchronizeCourtListenerQuota({
		api: options.quotaApi,
		coordinator: options.coordinator,
		now: options.now,
		token: options.token,
	});
	if (sync.kind === "rate_limited") return delayed("rate_limited", options.now(), sync.retryAt);
	if (sync.kind === "failed") return indeterminate("quota_unknown");
	const next = await value(() =>
		options.coordinator.admit({
			endpoint: "case_law",
			now: options.now(),
			reservationToken: options.token(),
		}),
	);
	return next === undefined
		? indeterminate("quota_unknown")
		: decide(next, options, request, false);
}

async function requestReserved<Value extends object>(
	reservationToken: string,
	options: CaseLawAdmissionOptions,
	request: () => Promise<CourtListenerCaseLawOutcome<Value>>,
): Promise<CaseLawRequestResult<Value>> {
	const source = await value(request);
	const outcome: CourtListenerOutcome =
		source === undefined ? { kind: "transport_error" } : outcomeFor(source, options.now());
	const recorded = await value(() =>
		options.coordinator.recordOutcome({
			endpoint: "case_law",
			now: options.now(),
			outcome,
			reservationToken,
		}),
	);
	if (recorded?.kind !== "recorded") return indeterminate("quota_unknown");
	return source === undefined ? indeterminate("upstream_unavailable") : { kind: "source", source };
}

function outcomeFor<Value extends object>(
	source: CourtListenerCaseLawOutcome<Value>,
	now: Date,
): CourtListenerOutcome {
	switch (source.kind) {
		case "found":
		case "missing":
			return { kind: "success" };
		case "malformed_response":
			return { kind: "malformed_response" };
		case "rate_limited":
			return {
				kind: "rate_limited",
				retryAt: new Date(now.getTime() + (source.retryAfterSeconds ?? 900) * 1_000),
			};
		case "unavailable":
			return source.failure === "server"
				? { kind: "server_error" }
				: source.failure === "timeout"
					? { kind: "timeout" }
					: { kind: "transport_error" };
		default:
			return assertNever(source);
	}
}

function delayed(
	reason: "circuit_open" | "rate_limited",
	now: Date,
	retryAt: Date,
): CaseLawRequestFailure {
	return {
		kind: "indeterminate",
		reason,
		retryAfterSeconds: Math.max(1, Math.ceil((retryAt.getTime() - now.getTime()) / 1_000)),
	};
}

function indeterminate(reason: CaseLawFailureReason): CaseLawRequestFailure {
	return { kind: "indeterminate", reason };
}

function value<Value>(call: () => Promise<Value>): Promise<Value | undefined> {
	return call().catch((error: unknown) => {
		if (error instanceof Error) return undefined;
		throw error;
	});
}

function assertNever(value: never): never {
	throw new TypeError(`Unexpected CourtListener case-law decision: ${String(value)}`);
}

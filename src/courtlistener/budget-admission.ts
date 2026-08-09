import type { AdmissionInput, BudgetDecision, QuotaSyncStart } from "./budget-contract.js";
import { recoverExpiredLeases, setCircuit } from "./budget-leases.js";
import {
	COURTLISTENER_LEASE_MILLISECONDS,
	QUOTA_SYNC_INTERVAL_MILLISECONDS,
	after,
} from "./budget-state.js";
import type {
	CircuitState,
	ConfirmedQuota,
	CourtListenerBudgetState,
	QuotaState,
	QuotaWindow,
} from "./budget-state.js";

export function admitCourtListenerRequest(input: AdmissionInput): BudgetDecision {
	const state = recoverExpiredLeases(input.state, input.now);
	if (state.pendingReservations.some((item) => item.token === input.reservationToken)) {
		return { kind: "reservation_conflict", state };
	}
	const circuit = state.circuits[input.endpoint];
	switch (circuit.kind) {
		case "open":
			if (input.now.getTime() < circuit.retryAt.getTime()) {
				return { kind: "circuit_open", retryAt: circuit.retryAt, state };
			}
			break;
		case "half_open":
			return { kind: "probe_in_flight", state };
		case "closed":
			break;
	}
	return admitQuota({ ...input, state }, circuit);
}

export function beginQuotaSync(input: {
	readonly now: Date;
	readonly state: CourtListenerBudgetState;
	readonly syncToken: string;
}): QuotaSyncStart {
	const state = recoverExpiredLeases(input.state, input.now);
	switch (state.quota.kind) {
		case "sync_in_progress":
			return { kind: "already_in_progress", state };
		case "unknown":
			return startQuotaSync(state, input.now, input.syncToken, null);
		case "confirmed":
			return startWhenDue(
				state,
				input.now,
				input.syncToken,
				state.quota.value,
				after(state.quota.value.confirmedAt, QUOTA_SYNC_INTERVAL_MILLISECONDS),
			);
		case "sync_backoff":
			return startWhenDue(
				state,
				input.now,
				input.syncToken,
				state.quota.prior,
				state.quota.retryAt,
			);
		case "rate_limited":
			return startWhenDue(
				state,
				input.now,
				input.syncToken,
				state.quota.prior,
				state.quota.retryAt,
			);
	}
}

function admitQuota(input: AdmissionInput, circuit: CircuitState): BudgetDecision {
	switch (input.state.quota.kind) {
		case "unknown":
			return { kind: "sync_required", state: input.state };
		case "sync_in_progress":
			return { kind: "sync_in_progress", state: input.state };
		case "rate_limited":
			return input.now.getTime() < input.state.quota.retryAt.getTime()
				? { kind: "quota_limited", retryAt: input.state.quota.retryAt, state: input.state }
				: { kind: "sync_required", state: input.state };
		case "sync_backoff":
			if (input.now.getTime() >= input.state.quota.retryAt.getTime()) {
				return { kind: "sync_required", state: input.state };
			}
			return input.state.quota.prior === null
				? { kind: "sync_unavailable", retryAt: input.state.quota.retryAt, state: input.state }
				: reserveFromQuota(input, circuit, input.state.quota.prior);
		case "confirmed":
			return input.now.getTime() >=
				after(input.state.quota.value.confirmedAt, QUOTA_SYNC_INTERVAL_MILLISECONDS).getTime()
				? { kind: "sync_required", state: input.state }
				: reserveFromQuota(input, circuit, input.state.quota.value);
	}
}

function reserveFromQuota(
	input: AdmissionInput,
	circuit: CircuitState,
	quota: ConfirmedQuota,
): BudgetDecision {
	const scopes = input.endpoint === "citation" ? ["user", "citations"] : ["user"];
	const windows = quota.windows.filter((window) => scopes.includes(window.scope));
	if (!scopes.every((scope) => windows.some((window) => window.scope === scope))) {
		return { kind: "quota_exhausted", retryAt: null, state: input.state };
	}
	const exhausted = windows.filter((window) => window.remaining <= 0);
	if (exhausted.length > 0) {
		return { kind: "quota_exhausted", retryAt: latestReset(exhausted), state: input.state };
	}
	return {
		kind: "reserved",
		state: reserve(input.state, input.endpoint, input.now, input.reservationToken, scopes, circuit),
		token: input.reservationToken,
	};
}

function reserve(
	state: CourtListenerBudgetState,
	endpoint: AdmissionInput["endpoint"],
	now: Date,
	token: string,
	scopes: readonly string[],
	circuit: CircuitState,
): CourtListenerBudgetState {
	const nextCircuit: CircuitState =
		circuit.kind === "open"
			? { kind: "half_open", openForMilliseconds: circuit.openForMilliseconds }
			: circuit;
	return setCircuit(
		{
			...state,
			pendingReservations: [
				...state.pendingReservations,
				{ endpoint, leaseExpiresAt: after(now, COURTLISTENER_LEASE_MILLISECONDS), token },
			],
			quota: decrementQuota(state.quota, scopes),
		},
		endpoint,
		nextCircuit,
	);
}

function decrementQuota(quota: QuotaState, scopes: readonly string[]): QuotaState {
	switch (quota.kind) {
		case "confirmed":
			return {
				...quota,
				value: {
					...quota.value,
					windows: decrementWindows(quota.value.windows, scopes),
				},
			};
		case "sync_backoff":
			return quota.prior === null
				? quota
				: {
						...quota,
						prior: {
							...quota.prior,
							windows: decrementWindows(quota.prior.windows, scopes),
						},
					};
		case "unknown":
		case "sync_in_progress":
		case "rate_limited":
			return quota;
	}
}

function decrementWindows(
	windows: readonly QuotaWindow[],
	scopes: readonly string[],
): readonly QuotaWindow[] {
	return windows.map((window) =>
		scopes.includes(window.scope) ? { ...window, remaining: window.remaining - 1 } : window,
	);
}

function startWhenDue(
	state: CourtListenerBudgetState,
	now: Date,
	token: string,
	prior: ConfirmedQuota | null,
	retryAt: Date,
): QuotaSyncStart {
	return now.getTime() < retryAt.getTime()
		? { kind: "not_due", retryAt, state }
		: startQuotaSync(state, now, token, prior);
}

function startQuotaSync(
	state: CourtListenerBudgetState,
	now: Date,
	token: string,
	prior: ConfirmedQuota | null,
): QuotaSyncStart {
	return {
		kind: "started",
		state: {
			...state,
			quota: {
				kind: "sync_in_progress",
				leaseExpiresAt: after(now, COURTLISTENER_LEASE_MILLISECONDS),
				prior,
				retryAt: null,
				token,
			},
		},
	};
}

function latestReset(windows: readonly QuotaWindow[]): Date | null {
	const resets = windows.flatMap((window) => (window.resetAt === null ? [] : [window.resetAt]));
	return resets.length === windows.length
		? new Date(Math.max(...resets.map((reset) => reset.getTime())))
		: null;
}

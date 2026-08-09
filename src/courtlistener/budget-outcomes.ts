import type {
	CourtListenerOutcome,
	OutcomeRecord,
	QuotaSyncCompletion,
} from "./budget-contract.js";
import {
	closedCircuit,
	failedCircuit,
	nonFailureCircuit,
	recoverExpiredLeases,
	setCircuit,
} from "./budget-leases.js";
import { QUOTA_SYNC_INTERVAL_MILLISECONDS, after } from "./budget-state.js";
import type {
	ConfirmedQuota,
	CourtListenerBudgetState,
	CourtListenerEndpoint,
	QuotaState,
	QuotaWindow,
} from "./budget-state.js";

export function recordQuotaSync(input: {
	readonly now: Date;
	readonly state: CourtListenerBudgetState;
	readonly syncToken: string;
	readonly windows: readonly QuotaWindow[];
}): QuotaSyncCompletion {
	const state = recoverExpiredLeases(input.state, input.now);
	if (state.quota.kind !== "sync_in_progress" || state.quota.token !== input.syncToken) {
		return { kind: "unknown_sync_token", state };
	}
	const value = { confirmedAt: input.now, windows: input.windows };
	return {
		kind: "recorded",
		state: {
			...state,
			quota:
				state.quota.retryAt === null
					? { kind: "confirmed", value }
					: { kind: "rate_limited", prior: value, retryAt: state.quota.retryAt },
		},
	};
}

export function failQuotaSync(input: {
	readonly now: Date;
	readonly state: CourtListenerBudgetState;
	readonly syncToken: string;
}): QuotaSyncCompletion {
	const state = recoverExpiredLeases(input.state, input.now);
	if (state.quota.kind !== "sync_in_progress" || state.quota.token !== input.syncToken) {
		return { kind: "unknown_sync_token", state };
	}
	const { prior, retryAt } = state.quota;
	return {
		kind: "recorded",
		state: {
			...state,
			quota:
				retryAt !== null && prior !== null
					? { kind: "rate_limited", prior, retryAt }
					: {
							kind: "sync_backoff",
							prior,
							retryAt: after(input.now, QUOTA_SYNC_INTERVAL_MILLISECONDS),
						},
		},
	};
}

export function recordCourtListenerOutcome(input: {
	readonly endpoint: CourtListenerEndpoint;
	readonly now: Date;
	readonly outcome: CourtListenerOutcome;
	readonly reservationToken: string;
	readonly state: CourtListenerBudgetState;
}): OutcomeRecord {
	const state = recoverExpiredLeases(input.state, input.now);
	const reservation = state.pendingReservations.find(
		(item) => item.token === input.reservationToken,
	);
	if (reservation === undefined || reservation.endpoint !== input.endpoint) {
		return { kind: "unknown_reservation", state };
	}
	const completed = {
		...state,
		pendingReservations: state.pendingReservations.filter((item) => item !== reservation),
	};
	switch (input.outcome.kind) {
		case "success":
			return { kind: "recorded", state: setCircuit(completed, input.endpoint, closedCircuit()) };
		case "timeout":
		case "server_error":
			return {
				kind: "recorded",
				state: setCircuit(
					completed,
					input.endpoint,
					failedCircuit(completed.circuits[input.endpoint], input.now),
				),
			};
		case "transport_error":
		case "malformed_response":
			return {
				kind: "recorded",
				state: setCircuit(
					completed,
					input.endpoint,
					nonFailureCircuit(completed.circuits[input.endpoint]),
				),
			};
		case "rate_limited":
			return {
				kind: "recorded",
				state: recordRateLimit(completed, input.endpoint, input.outcome.retryAt),
			};
	}
}

function recordRateLimit(
	state: CourtListenerBudgetState,
	endpoint: CourtListenerEndpoint,
	retryAt: Date,
): CourtListenerBudgetState {
	if (state.quota.kind === "sync_in_progress") {
		return setCircuit(
			{ ...state, quota: { ...state.quota, retryAt } },
			endpoint,
			nonFailureCircuit(state.circuits[endpoint]),
		);
	}
	const prior = confirmedQuota(state.quota);
	return prior === null
		? setCircuit(state, endpoint, nonFailureCircuit(state.circuits[endpoint]))
		: setCircuit(
				{ ...state, quota: { kind: "rate_limited", prior, retryAt } },
				endpoint,
				nonFailureCircuit(state.circuits[endpoint]),
			);
}

function confirmedQuota(quota: QuotaState): ConfirmedQuota | null {
	switch (quota.kind) {
		case "confirmed":
			return quota.value;
		case "sync_backoff":
		case "sync_in_progress":
			return quota.prior;
		case "unknown":
		case "rate_limited":
			return null;
	}
}

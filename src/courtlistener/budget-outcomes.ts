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
	CourtListenerDataEndpoint,
	QuotaState,
	QuotaWindow,
	Reservation,
} from "./budget-state.js";

export function recordQuotaSync(input: {
	readonly now: Date;
	readonly state: CourtListenerBudgetState;
	readonly syncToken: string;
	readonly windows: readonly QuotaWindow[];
}): QuotaSyncCompletion {
	const state = recoverExpiredLeases(input.state, input.now);
	const reservation = matchingSyncReservation(state, input.syncToken);
	if (state.quota.kind !== "sync_in_progress" || reservation === undefined) {
		return { kind: "unknown_sync_token", state };
	}
	const value = { confirmedAt: input.now, windows: input.windows };
	return {
		kind: "recorded",
		state: {
			...state,
			pendingReservations: withoutReservation(state, reservation),
			quota:
				state.quota.rateLimit === null
					? { kind: "confirmed", value }
					: {
							...state.quota.rateLimit,
							immediateSyncRequired: false,
							kind: "rate_limited",
							prior: value,
						},
		},
	};
}

export function failQuotaSync(input: {
	readonly now: Date;
	readonly state: CourtListenerBudgetState;
	readonly syncToken: string;
}): QuotaSyncCompletion {
	const state = recoverExpiredLeases(input.state, input.now);
	const reservation = matchingSyncReservation(state, input.syncToken);
	if (state.quota.kind !== "sync_in_progress" || reservation === undefined) {
		return { kind: "unknown_sync_token", state };
	}
	const { prior, rateLimit } = state.quota;
	return {
		kind: "recorded",
		state: {
			...state,
			pendingReservations: withoutReservation(state, reservation),
			quota:
				rateLimit !== null
					? { ...rateLimit, immediateSyncRequired: false, kind: "rate_limited", prior }
					: {
							kind: "sync_backoff",
							prior,
							retryAt: after(input.now, QUOTA_SYNC_INTERVAL_MILLISECONDS),
						},
		},
	};
}

export function recordQuotaSyncRateLimited(input: {
	readonly now: Date;
	readonly retryAt: Date;
	readonly state: CourtListenerBudgetState;
	readonly syncToken: string;
}): QuotaSyncCompletion {
	const state = recoverExpiredLeases(input.state, input.now);
	const reservation = matchingSyncReservation(state, input.syncToken);
	if (state.quota.kind !== "sync_in_progress" || reservation === undefined) {
		return { kind: "unknown_sync_token", state };
	}
	return {
		kind: "recorded",
		state: {
			...state,
			pendingReservations: withoutReservation(state, reservation),
			quota: {
				immediateSyncRequired: false,
				kind: "rate_limited",
				prior: state.quota.prior,
				retryAt: input.retryAt,
			},
		},
	};
}

export function recordCourtListenerOutcome(input: {
	readonly endpoint: CourtListenerDataEndpoint;
	readonly now: Date;
	readonly outcome: CourtListenerOutcome;
	readonly reservationToken: string;
	readonly state: CourtListenerBudgetState;
}): OutcomeRecord {
	const state = recoverExpiredLeases(input.state, input.now);
	const reservation = state.pendingReservations.find(
		(item) => item.token === input.reservationToken,
	);
	if (
		reservation === undefined ||
		reservation.kind !== "data" ||
		reservation.endpoint !== input.endpoint
	) {
		return { kind: "unknown_reservation", state };
	}
	const completed = {
		...state,
		pendingReservations: withoutReservation(state, reservation),
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
	endpoint: CourtListenerDataEndpoint,
	retryAt: Date,
): CourtListenerBudgetState {
	if (state.quota.kind === "sync_in_progress") {
		return setCircuit(
			{
				...state,
				quota: {
					...state.quota,
					rateLimit: {
						immediateSyncRequired: false,
						prior: state.quota.prior,
						retryAt,
					},
				},
			},
			endpoint,
			nonFailureCircuit(state.circuits[endpoint]),
		);
	}
	const prior = confirmedQuota(state.quota);
	return setCircuit(
		{
			...state,
			quota: { immediateSyncRequired: true, kind: "rate_limited", prior, retryAt },
		},
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
			return quota.kind === "rate_limited" ? quota.prior : null;
	}
}

function matchingSyncReservation(
	state: CourtListenerBudgetState,
	token: string,
): Extract<Reservation, { readonly kind: "quota_sync" }> | undefined {
	if (state.quota.kind !== "sync_in_progress" || state.quota.token !== token) return undefined;
	return state.pendingReservations.find(
		(item): item is Extract<Reservation, { readonly kind: "quota_sync" }> =>
			item.kind === "quota_sync" && item.token === token,
	);
}

function withoutReservation(
	state: CourtListenerBudgetState,
	reservation: Reservation,
): readonly Reservation[] {
	return state.pendingReservations.filter((item) => item !== reservation);
}

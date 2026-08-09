import {
	FIRST_OPEN_MILLISECONDS,
	QUOTA_SYNC_INTERVAL_MILLISECONDS,
	after,
} from "./budget-state.js";
import type {
	CircuitState,
	CourtListenerBudgetState,
	CourtListenerEndpoint,
} from "./budget-state.js";

export function recoverExpiredLeases(
	state: CourtListenerBudgetState,
	now: Date,
): CourtListenerBudgetState {
	const expired = state.pendingReservations.filter(
		(item) => now.getTime() >= item.leaseExpiresAt.getTime(),
	);
	const retained = state.pendingReservations.filter(
		(item) => now.getTime() < item.leaseExpiresAt.getTime(),
	);
	const reservationRecovered = expired.reduce<CourtListenerBudgetState>(
		(next, item) =>
			setCircuit(next, item.endpoint, failedCircuit(next.circuits[item.endpoint], now)),
		{ ...state, pendingReservations: retained },
	);
	if (
		reservationRecovered.quota.kind !== "sync_in_progress" ||
		now.getTime() < reservationRecovered.quota.leaseExpiresAt.getTime()
	) {
		return reservationRecovered;
	}
	return {
		...reservationRecovered,
		quota: {
			kind: "sync_backoff",
			prior: reservationRecovered.quota.prior,
			retryAt: after(now, QUOTA_SYNC_INTERVAL_MILLISECONDS),
		},
	};
}

export function failedCircuit(circuit: CircuitState, now: Date): CircuitState {
	switch (circuit.kind) {
		case "closed":
			switch (circuit.consecutiveFailures) {
				case 0:
					return { consecutiveFailures: 1, kind: "closed" };
				case 1:
					return { consecutiveFailures: 2, kind: "closed" };
				case 2:
					return openCircuit(FIRST_OPEN_MILLISECONDS, now);
			}
			return circuit;
		case "half_open":
			return openCircuit(Math.min(circuit.openForMilliseconds * 2, 5 * 60_000), now);
		case "open":
			return circuit;
	}
}

export function nonFailureCircuit(circuit: CircuitState): CircuitState {
	switch (circuit.kind) {
		case "closed":
		case "half_open":
			return closedCircuit();
		case "open":
			return circuit;
	}
}

export function closedCircuit(): CircuitState {
	return { consecutiveFailures: 0, kind: "closed" };
}

export function setCircuit(
	state: CourtListenerBudgetState,
	endpoint: CourtListenerEndpoint,
	circuit: CircuitState,
): CourtListenerBudgetState {
	return { ...state, circuits: { ...state.circuits, [endpoint]: circuit } };
}

function openCircuit(openForMilliseconds: number, now: Date): CircuitState {
	return { kind: "open", openForMilliseconds, retryAt: after(now, openForMilliseconds) };
}

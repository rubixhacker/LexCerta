import { describe, expect, it } from "vitest";
import {
	COURTLISTENER_LEASE_MILLISECONDS,
	type CourtListenerBudgetState,
	MAX_PENDING_RESERVATIONS,
	type QuotaWindow,
	admitCourtListenerRequest,
	beginQuotaSync,
	failQuotaSync,
	initialCourtListenerBudgetState,
	recordCourtListenerOutcome,
	recordQuotaSync,
	recordQuotaSyncRateLimited,
} from "./budget.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");

describe("CourtListener quota-sync reservations", () => {
	it("correlates each quota-sync completion to its durable quota_sync reservation", () => {
		// Given: a caller starts the only usage fetch with an opaque sync token.
		const started = beginQuotaSync({
			now: NOW,
			state: initialCourtListenerBudgetState(),
			syncToken: "sync-1",
		});

		// When: an unrelated completion and then the matching completion arrive.
		const rejected = recordQuotaSync({
			now: NOW,
			state: started.state,
			syncToken: "sync-other",
			windows: [window("user")],
		});
		const failedOther = failQuotaSync({
			now: NOW,
			state: rejected.state,
			syncToken: "sync-other",
		});
		const completed = recordQuotaSync({
			now: NOW,
			state: failedOther.state,
			syncToken: "sync-1",
			windows: [window("user")],
		});

		// Then: only the matching token consumes the durable sync reservation.
		expect(started.state.pendingReservations).toMatchObject([
			{ kind: "quota_sync", token: "sync-1" },
		]);
		expect(rejected).toMatchObject({
			kind: "unknown_sync_token",
			state: { pendingReservations: [{ kind: "quota_sync", token: "sync-1" }] },
		});
		expect(failedOther.kind).toBe("unknown_sync_token");
		expect(completed).toMatchObject({ kind: "recorded", state: { pendingReservations: [] } });
	});

	it("denies the one-hundred-first data or quota-sync reservation without changing state", () => {
		// Given: persisted state already holds every permitted durable lease.
		const dataState = confirmedState({
			pendingReservations: reservations(MAX_PENDING_RESERVATIONS),
		});
		const syncState = {
			...initialCourtListenerBudgetState(),
			pendingReservations: reservations(MAX_PENDING_RESERVATIONS),
		};

		// When: callers try to acquire the next data and quota-sync leases.
		const data = admit(dataState, "data-101");
		const sync = beginQuotaSync({ now: NOW, state: syncState, syncToken: "sync-101" });

		// Then: both observe a typed capacity denial and persist no invalid overflow.
		expect(data).toEqual({ kind: "reservation_capacity_exhausted", state: dataState });
		expect(sync).toEqual({ kind: "reservation_capacity_exhausted", state: syncState });
	});

	it("reconciles an unexpected data 429 once, then denies until Retry-After", () => {
		// Given: an admitted data request receives a 429 before any quota sync is active.
		const reserved = admit(confirmedState(), "data-429");
		if (reserved.kind !== "reserved") throw new RangeError("data request must reserve");
		const limited = recordCourtListenerOutcome({
			endpoint: "citation",
			now: NOW,
			outcome: { kind: "rate_limited", retryAt: at(30_000) },
			reservationToken: "data-429",
			state: reserved.state,
		});

		// When: two callers seek reconciliation, and the first sync completes.
		const recoveredAdmission = admit(limited.state, "after-worker-crash", 1);
		const started = beginQuotaSync({ now: at(1), state: limited.state, syncToken: "reconcile" });
		const duplicate = beginQuotaSync({ now: at(1), state: started.state, syncToken: "storm" });
		const failed = failQuotaSync({ now: at(2), state: started.state, syncToken: "reconcile" });
		const completed = recordQuotaSync({
			now: at(2),
			state: started.state,
			syncToken: "reconcile",
			windows: [window("user"), window("citations")],
		});

		// Then: exactly one sync lease exists, data remains denied, and Retry-After makes a new sync due.
		expect(started).toMatchObject({
			kind: "started",
			state: { pendingReservations: [{ kind: "quota_sync", token: "reconcile" }] },
		});
		expect(recoveredAdmission.kind).toBe("sync_required");
		expect(duplicate.kind).toBe("already_in_progress");
		expect(failed).toMatchObject({
			state: { quota: { immediateSyncRequired: false, kind: "rate_limited" } },
		});
		expect(beginQuotaSync({ now: at(2), state: failed.state, syncToken: "no-storm" }).kind).toBe(
			"not_due",
		);
		expect(admit(completed.state, "still-limited", 2)).toMatchObject({
			kind: "quota_limited",
			retryAt: at(30_000),
		});
		expect(beginQuotaSync({ now: at(30_000), state: completed.state, syncToken: "due" }).kind).toBe(
			"started",
		);
	});

	it("keeps quota-sync 429 fail-closed and expires its lease without affecting data circuits", () => {
		// Given: an initial sync is rate-limited and its correlated lease later expires.
		const started = beginQuotaSync({
			now: NOW,
			state: initialCourtListenerBudgetState(),
			syncToken: "limited-sync",
		});
		const limited = recordQuotaSyncRateLimited({
			now: NOW,
			retryAt: at(30_000),
			state: started.state,
			syncToken: "limited-sync",
		});
		const abandoned = beginQuotaSync({
			now: at(30_000),
			state: limited.state,
			syncToken: "abandoned",
		});

		// When: a data admission observes the exact quota-sync lease expiry.
		const decision = admit(
			abandoned.state,
			"after-expiry",
			30_000 + COURTLISTENER_LEASE_MILLISECONDS,
		);

		// Then: it is fail-closed while citation and case-law failure counters remain untouched.
		expect(limited.state.quota).toMatchObject({ kind: "rate_limited", prior: null });
		expect(admit(limited.state, "before-retry", 1)).toMatchObject({
			kind: "quota_limited",
			retryAt: at(30_000),
		});
		expect(decision).toMatchObject({
			kind: "sync_unavailable",
			state: {
				circuits: {
					case_law: { consecutiveFailures: 0, kind: "closed" },
					citation: { consecutiveFailures: 0, kind: "closed" },
				},
				pendingReservations: [],
				quota: { kind: "sync_backoff" },
			},
		});
	});
});

function admit(state: CourtListenerBudgetState, reservationToken: string, offset = 0) {
	return admitCourtListenerRequest({
		endpoint: "citation",
		now: at(offset),
		reservationToken,
		state,
	});
}

function at(offset: number): Date {
	return new Date(NOW.getTime() + offset);
}

function confirmedState(
	override: Partial<CourtListenerBudgetState> = {},
): CourtListenerBudgetState {
	const started = beginQuotaSync({
		now: NOW,
		state: initialCourtListenerBudgetState(),
		syncToken: "initial",
	});
	const completed = recordQuotaSync({
		now: NOW,
		state: started.state,
		syncToken: "initial",
		windows: [window("user"), window("citations")],
	});
	if (completed.kind !== "recorded") throw new RangeError("quota sync must be recorded");
	return { ...completed.state, ...override };
}

function reservations(count: number) {
	return Array.from({ length: count }, (_, index) => ({
		endpoint: "citation" as const,
		kind: "data" as const,
		leaseExpiresAt: at(COURTLISTENER_LEASE_MILLISECONDS),
		token: `pending-${index}`,
	}));
}

function window(scope: string): QuotaWindow {
	return {
		limit: 100,
		rate: "minute",
		remaining: 100,
		resetAt: at(60_000),
		scope,
		windowSeconds: 60,
	};
}

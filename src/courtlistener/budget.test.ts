import { describe, expect, it } from "vitest";
import {
	COURTLISTENER_LEASE_MILLISECONDS,
	type CourtListenerBudgetState,
	type QuotaWindow,
	admitCourtListenerRequest,
	beginQuotaSync,
	failQuotaSync,
	initialCourtListenerBudgetState,
	recordCourtListenerOutcome,
	recordQuotaSync,
} from "./budget.js";
const NOW = new Date("2026-08-09T12:00:00.000Z");
describe("CourtListener budget", () => {
	it("keeps durable leases longer than the current upstream HTTP timeout", () => {
		// Given: the CourtListener adapter's bounded HTTP timeout is five seconds.
		const httpTimeoutMilliseconds = 5_000;

		// When: the pure coordinator exposes its persisted lease duration.
		const leaseDuration = COURTLISTENER_LEASE_MILLISECONDS;

		// Then: a normal timeout outcome can reach the coordinator before lease recovery.
		expect(leaseDuration).toBeGreaterThan(httpTimeoutMilliseconds);
	});

	it("requires a quota sync before the first upstream request", () => {
		// Given: no CourtListener quota has ever been confirmed.
		const state = initialCourtListenerBudgetState();

		// When: a citation request needs one reservation.
		const decision = admit(state, "citation", "first-request");

		// Then: it fails closed and names the required quota synchronization.
		expect(decision.kind).toBe("sync_required");
	});

	it("makes one opaque quota-sync lease visible to concurrent callers", () => {
		// Given: the first serialized caller has acquired the only usage-sync token.
		const started = beginQuotaSync({
			now: NOW,
			state: initialCourtListenerBudgetState(),
			syncToken: "usage-1",
		});

		// When: another caller needs upstream capacity before the sync completes.
		const decision = admit(started.state, "citation", "second-request");

		// Then: it observes the in-progress lease instead of requesting another sync.
		expect(decision.kind).toBe("sync_in_progress");
	});

	it("backs off a failed initial sync before allowing exactly one new lease", () => {
		// Given: the first usage sync failed with no confirmed quota to preserve.
		const started = beginQuotaSync({
			now: NOW,
			state: initialCourtListenerBudgetState(),
			syncToken: "usage-1",
		});
		const failed = failQuotaSync({ now: NOW, state: started.state, syncToken: "usage-1" });

		// When: a request arrives one millisecond before the retry boundary.
		const blocked = admit(failed.state, "citation", "blocked", -1);

		// Then: it is denied with the persisted backoff deadline, and direct sync acquisition cannot bypass it.
		expect(blocked).toMatchObject({
			kind: "sync_unavailable",
			retryAt: new Date(NOW.getTime() + 15 * 60_000),
		});
		expect(
			beginQuotaSync({
				now: new Date(NOW.getTime() + 15 * 60_000 - 1),
				state: failed.state,
				syncToken: "bypass",
			}).kind,
		).toBe("not_due");
		expect(admit(failed.state, "citation", "boundary", 15 * 60_000).kind).toBe("sync_required");
	});

	it("recovers an expired quota-sync lease before a new caller can be stranded", () => {
		// Given: an initial usage sync lease has no completed observation.
		const started = beginQuotaSync({
			now: NOW,
			state: initialCourtListenerBudgetState(),
			syncToken: "expired-sync",
		});

		// When: the next caller arrives at the exact durable lease expiry.
		const beforeExpiry = admit(
			started.state,
			"citation",
			"before-expired-sync",
			COURTLISTENER_LEASE_MILLISECONDS - 1,
		);
		const decision = admit(
			started.state,
			"citation",
			"after-expired-sync",
			COURTLISTENER_LEASE_MILLISECONDS,
		);

		// Then: the lease is converted to fail-closed retry state instead of remaining in progress.
		expect(beforeExpiry.kind).toBe("sync_in_progress");
		expect(decision).toMatchObject({
			kind: "sync_unavailable",
			state: { quota: { kind: "sync_backoff" } },
		});
	});

	it("reserves only citation-applicable quota windows and consumes its token once", () => {
		// Given: live quota has user, citation, and unrelated usage windows.
		const state = confirmedState([
			window("user", "minute", 2),
			window("citations", "minute", 2),
			window("citations", "hour", 3),
			window("api_usage", "minute", 9),
		]);

		// When: one citation request receives reservation token citation-1.
		const reserved = admit(state, "citation", "citation-1");

		// Then: only user/citation remaining decrements while limit/window metadata persists.
		expect(reserved).toMatchObject({
			kind: "reserved",
			state: {
				quota: {
					value: {
						windows: [
							window("user", "minute", 1),
							window("citations", "minute", 1),
							window("citations", "hour", 2),
							window("api_usage", "minute", 9),
						],
					},
				},
			},
		});
		if (reserved.kind !== "reserved") throw new RangeError("reservation must be admitted");
		expect(
			recordCourtListenerOutcome({
				endpoint: "citation",
				now: NOW,
				outcome: { kind: "success" },
				reservationToken: "not-citation-1",
				state: reserved.state,
			}).kind,
		).toBe("unknown_reservation");
	});

	it("requires a refresh at the exact confirmed-quota fifteen-minute boundary", () => {
		// Given: quota was confirmed fifteen minutes ago and still has capacity.
		const state = confirmedState([window("user", "minute", 1)], -15 * 60_000);

		// When: a case-law request arrives at the exact boundary.
		const decision = admit(state, "case_law", "boundary");

		// Then: it requests a fresh quota observation before transmission.
		expect(decision.kind).toBe("sync_required");
	});

	it("treats a 429 as immediate quota reconciliation without circuit failure", () => {
		// Given: a citation request was reserved against confirmed quota.
		const reserved = admit(
			confirmedState([window("user", "minute", 2), window("citations", "minute", 2)]),
			"citation",
			"citation-429",
		);
		if (reserved.kind !== "reserved") throw new RangeError("reservation must be admitted");
		const rateLimited = recordCourtListenerOutcome({
			endpoint: "citation",
			now: NOW,
			outcome: { kind: "rate_limited", retryAt: new Date(NOW.getTime() + 30_000) },
			reservationToken: "citation-429",
			state: reserved.state,
		});

		// When: requests arrive just before and exactly at Retry-After.
		const before = admit(rateLimited.state, "citation", "before", 29_999);
		const boundary = admit(rateLimited.state, "citation", "boundary", 30_000);

		// Then: it does not add a circuit failure and reconciliation survives the retry window.
		expect(before.kind).toBe("sync_required");
		expect(boundary.kind).toBe("sync_required");
		expect(rateLimited.state.circuits.citation).toEqual({ kind: "closed", consecutiveFailures: 0 });
	});
});

function admit(
	state: CourtListenerBudgetState,
	endpoint: "citation" | "case_law",
	reservationToken: string,
	offset = 0,
) {
	return admitCourtListenerRequest({
		endpoint,
		now: new Date(NOW.getTime() + offset),
		reservationToken,
		state,
	});
}

function confirmedState(
	windows: readonly QuotaWindow[],
	confirmedOffset = 0,
): CourtListenerBudgetState {
	const started = beginQuotaSync({
		now: new Date(NOW.getTime() + confirmedOffset),
		state: initialCourtListenerBudgetState(),
		syncToken: "usage",
	});
	const completed = recordQuotaSync({
		now: new Date(NOW.getTime() + confirmedOffset),
		state: started.state,
		syncToken: "usage",
		windows,
	});
	if (completed.kind !== "recorded") throw new RangeError("quota sync must be recorded");
	return completed.state;
}
function failRequest(
	state: CourtListenerBudgetState,
	endpoint: "citation" | "case_law",
	token: string,
	offset = 0,
): CourtListenerBudgetState {
	const reserved = admit(state, endpoint, token, offset);
	if (reserved.kind !== "reserved") throw new RangeError("request must be admitted");
	const failed = recordCourtListenerOutcome({
		endpoint,
		now: new Date(NOW.getTime() + offset),
		outcome: { kind: "server_error" },
		reservationToken: token,
		state: reserved.state,
	});
	if (failed.kind !== "recorded") throw new RangeError("outcome must be recorded");
	return failed.state;
}
function window(scope: string, rate: string, remaining: number): QuotaWindow {
	return {
		limit: 10,
		rate,
		remaining,
		resetAt: new Date(NOW.getTime() + 60_000),
		scope,
		windowSeconds: 60,
	};
}

import { describe, expect, it } from "vitest";
import {
	COURTLISTENER_LEASE_MILLISECONDS,
	type CourtListenerBudgetState,
	type QuotaWindow,
	admitCourtListenerRequest,
	beginQuotaSync,
	initialCourtListenerBudgetState,
	recordCourtListenerOutcome,
	recordQuotaSync,
} from "./budget.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");

describe("CourtListener budget circuits", () => {
	it("consumes neutral outcomes and resolves a rate-limited half-open probe", () => {
		// Given: citation has one server failure, then a separate open-circuit probe.
		let state = failRequest(
			confirmedState([window("user", "minute", 10), window("citations", "minute", 10)]),
			"citation",
			"failure-1",
		);
		const neutral = admit(state, "citation", "transport");
		if (neutral.kind !== "reserved") throw new RangeError("neutral request must be admitted");
		state = recordCourtListenerOutcome({
			endpoint: "citation",
			now: NOW,
			outcome: { kind: "transport_error" },
			reservationToken: "transport",
			state: neutral.state,
		}).state;
		state = failRequest(
			failRequest(failRequest(state, "citation", "failure-2"), "citation", "failure-3"),
			"citation",
			"failure-4",
		);
		const probe = admit(state, "citation", "rate-limited-probe", 30_000);
		if (probe.kind !== "reserved") throw new RangeError("probe must be admitted");

		// When: the half-open probe receives 429 instead of a timeout or 5xx.
		const outcome = recordCourtListenerOutcome({
			endpoint: "citation",
			now: new Date(NOW.getTime() + 30_000),
			outcome: { kind: "rate_limited", retryAt: new Date(NOW.getTime() + 60_000) },
			reservationToken: "rate-limited-probe",
			state: probe.state,
		});

		// Then: neutral transport did not count toward opening, and 429 cannot strand the probe.
		expect(outcome.state.pendingReservations).toEqual([]);
		expect(outcome.state.circuits.citation).toEqual({ kind: "closed", consecutiveFailures: 0 });
	});

	it("opens only the failing endpoint after three failures and allows one half-open probe", () => {
		// Given: citation has three admitted server failures while case-law has not failed.
		let state = confirmedState([window("user", "minute", 10), window("citations", "minute", 10)]);
		for (const token of ["failure-1", "failure-2", "failure-3"])
			state = failRequest(state, "citation", token);

		// When: citation and case-law request capacity before and at citation recovery.
		const open = admit(state, "citation", "blocked");
		const caseLaw = admit(state, "case_law", "case-law");
		const probe = admit(state, "citation", "probe", 30_000);

		// Then: citation alone is open, case-law reserves, and the single probe excludes a second probe.
		expect(open).toMatchObject({ kind: "circuit_open", retryAt: new Date(NOW.getTime() + 30_000) });
		expect(caseLaw.kind).toBe("reserved");
		expect(probe.kind).toBe("reserved");
		if (probe.kind !== "reserved") throw new RangeError("probe must be admitted");
		expect(admit(probe.state, "citation", "second-probe", 30_000).kind).toBe("probe_in_flight");
	});

	it("recovers an expired half-open reservation as a failed probe at the exact boundary", () => {
		// Given: a citation circuit has admitted its only half-open probe.
		let state = confirmedState([window("user", "minute", 10), window("citations", "minute", 10)]);
		for (const token of ["failure-1", "failure-2", "failure-3"])
			state = failRequest(state, "citation", token);
		const probe = admit(state, "citation", "abandoned-probe", 30_000);
		if (probe.kind !== "reserved") throw new RangeError("probe must be admitted");

		// When: another caller arrives at the probe reservation's exact lease expiry.
		const beforeExpiry = admit(
			probe.state,
			"citation",
			"before-abandoned-probe",
			30_000 + COURTLISTENER_LEASE_MILLISECONDS - 1,
		);
		const recovered = admit(
			probe.state,
			"citation",
			"after-abandoned-probe",
			30_000 + COURTLISTENER_LEASE_MILLISECONDS,
		);
		const lateOutcome = recordCourtListenerOutcome({
			endpoint: "citation",
			now: new Date(NOW.getTime() + 30_000 + COURTLISTENER_LEASE_MILLISECONDS),
			outcome: { kind: "success" },
			reservationToken: "abandoned-probe",
			state: probe.state,
		});

		// Then: the abandoned probe is consumed and citation reopens with doubled backoff.
		expect(beforeExpiry.kind).toBe("probe_in_flight");
		expect(recovered).toMatchObject({
			kind: "circuit_open",
			state: {
				pendingReservations: [],
				circuits: { citation: { kind: "open", openForMilliseconds: 60_000 } },
			},
		});
		expect(lateOutcome).toMatchObject({
			kind: "unknown_reservation",
			state: {
				pendingReservations: [],
				circuits: { citation: { kind: "open", openForMilliseconds: 60_000 } },
			},
		});
	});

	it("doubles failed half-open periods to five minutes and closes on success", () => {
		// Given: a citation circuit is open after three failures.
		let state = confirmedState([window("user", "minute", 20), window("citations", "minute", 20)]);
		for (const token of ["failure-1", "failure-2", "failure-3"])
			state = failRequest(state, "citation", token);

		// When: four half-open probes fail, then a fifth succeeds at the capped boundary.
		for (const [offset, token] of [
			[30_000, "probe-1"],
			[90_000, "probe-2"],
			[210_000, "probe-3"],
			[450_000, "probe-4"],
		] as const)
			state = failRequest(state, "citation", token, offset);
		const recovered = admit(state, "citation", "recovered", 750_000);
		if (recovered.kind !== "reserved") throw new RangeError("capped probe must be admitted");
		const closed = recordCourtListenerOutcome({
			endpoint: "citation",
			now: new Date(NOW.getTime() + 750_000),
			outcome: { kind: "success" },
			reservationToken: "recovered",
			state: recovered.state,
		});

		// Then: the fourth failure caps the open duration at five minutes and success closes it.
		expect(state.circuits.citation).toEqual({
			kind: "open",
			openForMilliseconds: 300_000,
			retryAt: new Date(NOW.getTime() + 750_000),
		});
		expect(closed.state.circuits.citation).toEqual({ kind: "closed", consecutiveFailures: 0 });
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

function confirmedState(windows: readonly QuotaWindow[]): CourtListenerBudgetState {
	const started = beginQuotaSync({
		now: NOW,
		state: initialCourtListenerBudgetState(),
		syncToken: "usage",
	});
	const completed = recordQuotaSync({
		now: NOW,
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
		limit: 20,
		rate,
		remaining,
		resetAt: new Date(NOW.getTime() + 60_000),
		scope,
		windowSeconds: 60,
	};
}

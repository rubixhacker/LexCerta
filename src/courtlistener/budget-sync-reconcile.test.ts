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

describe("CourtListener stale quota-sync reconciliation", () => {
	it("reapplies a completed citation reservation after a stale successful snapshot", () => {
		const reserved = admit(
			confirmed([window("user", 1), window("citations", 1), window("api_usage", 10)]),
			"citation",
			"data-a",
		);
		if (reserved.kind !== "reserved") throw new RangeError("citation must reserve");
		const started = beginQuotaSync({ now: at(1), state: reserved.state, syncToken: "usage" });
		if (started.kind !== "started") throw new RangeError("sync must start");
		const completedData = recordCourtListenerOutcome({
			endpoint: "citation",
			now: at(2),
			outcome: { kind: "success" },
			reservationToken: "data-a",
			state: started.state,
		});
		const completedSync = recordQuotaSync({
			now: at(3),
			state: completedData.state,
			syncToken: "usage",
			windows: [window("user", 1), window("citations", 1)],
		});
		const evicted = admit(
			started.state,
			"citation",
			"after-eviction",
			COURTLISTENER_LEASE_MILLISECONDS + 1,
		);

		expect(started.state.quota).toMatchObject({
			capturedDataReservationEndpoints: ["citation"],
			kind: "sync_in_progress",
		});
		expect(completedSync.state.quota).toMatchObject({
			kind: "confirmed",
			value: { windows: [window("user", 0), window("citations", 0)] },
		});
		expect(admit(completedSync.state, "citation", "second", 4).kind).toBe("quota_exhausted");
		expect(evicted.state.quota).toMatchObject({ kind: "sync_backoff" });
	});

	it("reapplies mixed captured endpoints to every applicable rolling window", () => {
		let state = confirmed([
			window("user", 3, "minute"),
			window("user", 3, "hour"),
			window("citations", 2, "minute"),
			window("citations", 2, "hour"),
			window("api_usage", 10),
		]);
		const citation = admit(state, "citation", "citation-a");
		if (citation.kind !== "reserved") throw new RangeError("citation must reserve");
		state = citation.state;
		const caseLaw = admit(state, "case_law", "case-a");
		if (caseLaw.kind !== "reserved") throw new RangeError("case law must reserve");
		const started = beginQuotaSync({ now: at(1), state: caseLaw.state, syncToken: "mixed" });
		if (started.kind !== "started") throw new RangeError("sync must start");
		const completed = recordQuotaSync({
			now: at(2),
			state: started.state,
			syncToken: "mixed",
			windows: [
				window("user", 2, "minute"),
				window("user", 2, "hour"),
				window("citations", 1, "minute"),
				window("citations", 1, "hour"),
			],
		});

		expect(completed.state.quota).toMatchObject({
			kind: "confirmed",
			value: {
				windows: [
					{ rate: "minute", remaining: 0, scope: "user" },
					{ rate: "hour", remaining: 0, scope: "user" },
					{ rate: "minute", remaining: 0, scope: "citations" },
					{ rate: "hour", remaining: 0, scope: "citations" },
				],
			},
		});
	});
});

function admit(
	state: CourtListenerBudgetState,
	endpoint: "citation" | "case_law",
	reservationToken: string,
	offset = 0,
) {
	return admitCourtListenerRequest({ endpoint, now: at(offset), reservationToken, state });
}

function confirmed(windows: readonly QuotaWindow[]): CourtListenerBudgetState {
	const confirmedAt = at(-15 * 60_000 + 1);
	const started = beginQuotaSync({
		now: confirmedAt,
		state: initialCourtListenerBudgetState(),
		syncToken: "initial",
	});
	const completed = recordQuotaSync({
		now: confirmedAt,
		state: started.state,
		syncToken: "initial",
		windows,
	});
	if (completed.kind !== "recorded") throw new RangeError("quota sync must be recorded");
	return completed.state;
}

function at(offset: number): Date {
	return new Date(NOW.getTime() + offset);
}

function window(scope: string, remaining: number, rate = "minute"): QuotaWindow {
	return {
		limit: Math.max(remaining, 1),
		rate,
		remaining,
		resetAt: at(60 * 60_000),
		scope,
		windowSeconds: 60,
	};
}

import { describe, expect, it } from "vitest";
import {
	COURTLISTENER_LEASE_MILLISECONDS,
	type CourtListenerBudgetState,
	type QuotaWindow,
	beginQuotaSync,
	failQuotaSync,
	initialCourtListenerBudgetState,
	recordQuotaSync,
	recordQuotaSyncRateLimited,
} from "./budget.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");

describe("CourtListener api_usage quota sync budget", () => {
	it("allows the initial unknown-quota bootstrap without api_usage windows", () => {
		expect(
			beginQuotaSync({
				now: NOW,
				state: initialCourtListenerBudgetState(),
				syncToken: "bootstrap",
			}),
		).toMatchObject({
			kind: "started",
			state: { pendingReservations: [{ kind: "quota_sync", token: "bootstrap" }] },
		});
	});

	it("charges the final api_usage allowance through failed and expired sync recovery", () => {
		const started = sync(confirmed([window("api_usage", 1, 1)]), "final");
		if (started.kind !== "started") throw new RangeError("final sync must start");
		const failed = failQuotaSync({
			now: at(15 * 60_000),
			state: started.state,
			syncToken: "final",
		});
		const rateLimited = recordQuotaSyncRateLimited({
			now: at(15 * 60_000),
			retryAt: at(30 * 60_000),
			state: started.state,
			syncToken: "final",
		});
		const evicted = sync(started.state, "expired", 15 * 60_000 + COURTLISTENER_LEASE_MILLISECONDS);
		const recovered = sync(
			evicted.state,
			"retry-after-eviction",
			30 * 60_000 + COURTLISTENER_LEASE_MILLISECONDS,
		);
		const retry = sync(failed.state, "retry-after-failure", 30 * 60_000);

		expect(started.state.quota).toMatchObject({
			kind: "sync_in_progress",
			prior: { windows: [window("api_usage", 1, 0)] },
		});
		expect(failed.state.quota).toMatchObject({
			kind: "sync_backoff",
			prior: { windows: [window("api_usage", 1, 0)] },
		});
		expect(rateLimited.state.quota).toMatchObject({
			kind: "rate_limited",
			prior: { windows: [window("api_usage", 1, 0)] },
		});
		expect(recovered).toEqual({
			kind: "quota_sync_quota_exhausted",
			retryAt: at(60 * 60_000),
			state: recovered.state,
		});
		expect(retry).toEqual({
			kind: "quota_sync_quota_exhausted",
			retryAt: at(60 * 60_000),
			state: retry.state,
		});
	});

	it("requires and charges every api_usage window without touching data quotas", () => {
		const started = sync(
			confirmed([
				window("user", 10, 7),
				window("citations", 10, 6),
				window("api_usage", 2, 2, "minute"),
				window("api_usage", 3, 3, "hour"),
			]),
			"multiple",
		);

		expect(started).toMatchObject({
			kind: "started",
			state: {
				quota: {
					prior: {
						windows: [
							window("user", 10, 7),
							window("citations", 10, 6),
							window("api_usage", 2, 1, "minute"),
							window("api_usage", 3, 2, "hour"),
						],
					},
				},
			},
		});
	});

	it("normalizes a reset boundary and denies missing or active exhausted api_usage", () => {
		const reset = sync(confirmed([window("api_usage", 2, 0, "minute", at(15 * 60_000))]), "reset");
		const missing = sync(confirmed([window("user", 2, 2)]), "missing");
		const exhausted = sync(
			confirmed([window("api_usage", 2, 0, "minute", at(30 * 60_000))]),
			"exhausted",
		);

		expect(reset).toMatchObject({
			kind: "started",
			state: { quota: { prior: { windows: [window("api_usage", 2, 1, "minute", null)] } } },
		});
		expect(missing).toMatchObject({ kind: "quota_sync_quota_exhausted", retryAt: null });
		expect(exhausted).toMatchObject({
			kind: "quota_sync_quota_exhausted",
			retryAt: at(30 * 60_000),
		});
	});
});

function sync(state: CourtListenerBudgetState, syncToken: string, offset = 15 * 60_000) {
	return beginQuotaSync({ now: at(offset), state, syncToken });
}

function confirmed(windows: readonly QuotaWindow[]): CourtListenerBudgetState {
	const started = beginQuotaSync({
		now: NOW,
		state: initialCourtListenerBudgetState(),
		syncToken: "initial",
	});
	const completed = recordQuotaSync({
		now: NOW,
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

function window(
	scope: string,
	limit: number,
	remaining: number,
	rate = "minute",
	resetAt: Date | null = at(60 * 60_000),
): QuotaWindow {
	return { limit, rate, remaining, resetAt, scope, windowSeconds: 60 };
}

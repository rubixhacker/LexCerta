import { describe, expect, it } from "vitest";
import { DEFAULT_API_KEY_LIMITS } from "../admin/key-lifecycle.js";
import { admitRollingWindow } from "./rolling-window.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const MINUTE_MILLISECONDS = 60_000;
const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;

describe("admitRollingWindow", () => {
	it("allows the sixtieth simultaneous request when D1 supplies pilot defaults", () => {
		// Given: D1 has supplied the 60/minute and 1,000/day pilot limits with 59 requests now.
		const admissions = Array.from({ length: 59 }, () => new Date(NOW));

		// When: the per-key coordinator asks to admit one more request at the same timestamp.
		const decision = admitRollingWindow({
			admissions,
			clock: fixedClock(NOW),
			limits: DEFAULT_API_KEY_LIMITS,
		});

		// Then: that distinct request is charged and allowed.
		expect(decision).toEqual({
			kind: "allowed",
			admissions: Array.from({ length: 60 }, () => new Date(NOW)),
		});
	});

	it("rejects a further simultaneous request with a one-minute Retry-After", () => {
		// Given: D1 has supplied pilot limits and all 60 minute slots were charged now.
		const admissions = Array.from({ length: 60 }, () => new Date(NOW));

		// When: another request arrives at exactly the same timestamp.
		const decision = admitRollingWindow({
			admissions,
			clock: fixedClock(NOW),
			limits: DEFAULT_API_KEY_LIMITS,
		});

		// Then: it is uncharged and the client is told to wait for the exact rolling boundary.
		expect(decision).toEqual({
			kind: "exhausted",
			admissions,
			retryAfterSeconds: 60,
		});
	});

	it("evicts an admission at the exact rolling-minute boundary before charging", () => {
		// Given: the only minute admission occurred exactly one minute ago.
		const admissions = [new Date(NOW.getTime() - MINUTE_MILLISECONDS)];

		// When: a request arrives at the rolling boundary under a one-request minute allowance.
		const decision = admitRollingWindow({
			admissions,
			clock: fixedClock(NOW),
			limits: { minute: 1, day: 2 },
		});

		// Then: it is evicted from the minute count, charged, and retained for the rolling day.
		expect(decision).toEqual({
			kind: "allowed",
			admissions: [new Date(NOW.getTime() - MINUTE_MILLISECONDS), new Date(NOW)],
		});
	});

	it("uses D1's day limit even after minute admissions have expired", () => {
		// Given: two admissions remain inside a three-request day but outside the minute window.
		const admissions = [
			new Date(NOW.getTime() - 2 * MINUTE_MILLISECONDS),
			new Date(NOW.getTime() - MINUTE_MILLISECONDS - 1),
			new Date(NOW.getTime() - 1),
		];

		// When: D1 supplies a one-per-minute, three-per-day allowance and another request arrives.
		const decision = admitRollingWindow({
			admissions,
			clock: fixedClock(NOW),
			limits: { minute: 1, day: 3 },
		});

		// Then: the day window is exhausted even though the minute has capacity after eviction.
		expect(decision).toEqual({
			kind: "exhausted",
			admissions,
			retryAfterSeconds: Math.ceil((DAY_MILLISECONDS - 2 * MINUTE_MILLISECONDS) / 1_000),
		});
	});

	it("uses the latest exhausted-window opening as Retry-After", () => {
		// Given: the minute opens in 15 seconds, while D1's independently exhausted day opens in 43.
		const admissions = [
			new Date(NOW.getTime() - 45_000),
			new Date(NOW.getTime() - DAY_MILLISECONDS + 43_000),
		];

		// When: the coordinator evaluates another request with one minute slot and two day slots.
		const decision = admitRollingWindow({
			admissions,
			clock: fixedClock(NOW),
			limits: { minute: 1, day: 2 },
		});

		// Then: it directs the caller to wait until both allowance windows can admit the request.
		expect(decision).toEqual({
			kind: "exhausted",
			admissions,
			retryAfterSeconds: 43,
		});
	});
});

function fixedClock(now: Date): { readonly now: () => Date } {
	return { now: () => new Date(now) };
}

import {
	env,
	evictDurableObject,
	runDurableObjectAlarm,
	runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

type Admission = {
	readonly admittedAt: number;
	readonly limits: { readonly day: number; readonly minute: number };
};

function limiterFor(publicId: string) {
	return env.API_KEY_LIMITER.getByName(publicId);
}

function admission(admittedAt: number, limits = { minute: 2, day: 10 }): Admission {
	return { admittedAt, limits };
}

describe("ApiKeyLimiter Durable Object", () => {
	it("authoritatively admits only the configured rolling-minute allowance across concurrent calls", async () => {
		// Given: one API-key object with a two-request rolling-minute allowance.
		const limiter = limiterFor("concurrent-minute-limit");
		const request = admission(Date.now());

		// When: three requests arrive concurrently at the same instant.
		const outcomes = await Promise.all([
			limiter.admit(request),
			limiter.admit(request),
			limiter.admit(request),
		]);

		// Then: exactly two consume the allowance and the rejected request gives a client backoff.
		expect(outcomes.filter((outcome) => outcome.kind === "allowed")).toHaveLength(2);
		expect(outcomes).toContainEqual({ kind: "exhausted", retryAfterSeconds: 60 });
	});

	it("uses the latest supplied limits while retaining durable rolling usage", async () => {
		// Given: a key object with two prior admissions and an allowance later raised by D1.
		const limiter = limiterFor("latest-limits");
		const now = Date.now();
		await limiter.admit(admission(now));
		await limiter.admit(admission(now + 1_000));

		// When: a later admission presents the updated three-request limit through a fresh stub.
		const result = await limiterFor("latest-limits").admit(
			admission(now + 2_000, { minute: 3, day: 10 }),
		);

		// Then: persisted usage survives the separate binding lookup and the raised limit is honored.
		expect(result).toEqual({ kind: "allowed" });
	});

	it("retains the rolling allowance after workerd evicts the object instance", async () => {
		// Given: a running key object that has consumed its one-request minute allowance.
		const limiter = limiterFor("eviction");
		const now = Date.now();
		await limiter.admit(admission(now, { minute: 1, day: 10 }));

		// When: workerd evicts the instance and a replacement receives another request.
		await evictDurableObject(limiter);
		const result = await limiter.admit(admission(now + 1_000, { minute: 1, day: 10 }));

		// Then: the reconstructed object reads SQLite state instead of resetting the allowance.
		expect(result).toEqual({ kind: "exhausted", retryAfterSeconds: 59 });
	});

	it("prunes expired SQLite usage and reschedules its alarm", async () => {
		// Given: a key object with one current admission and one usage row beyond its retention horizon.
		const limiter = limiterFor("alarm");
		const now = Date.now();
		await limiter.admit(admission(now));
		await runInDurableObject(limiter, (_instance, state) => {
			state.storage.sql.exec(
				"INSERT INTO api_key_admissions (admitted_at) VALUES (?1)",
				now - DAY - 1,
			);
		});

		// When: workerd fires the Durable Object alarm.
		const alarmRan = await runDurableObjectAlarm(limiter);
		const remaining = await runInDurableObject(limiter, (_instance, state) => {
			return state.storage.sql
				.exec<{ readonly count: number }>("SELECT COUNT(*) AS count FROM api_key_admissions")
				.one().count;
		});
		const nextAlarm = await runInDurableObject(limiter, (_instance, state) => {
			return state.storage.getAlarm();
		});

		// Then: cleanup is idempotent, removes expired usage, and leaves a future alarm scheduled.
		expect(alarmRan).toBe(true);
		expect(remaining).toBe(1);
		expect(nextAlarm).toBeGreaterThan(now);
	});

	it("enforces the rolling-day allowance after minute windows have opened", async () => {
		// Given: two requests that no longer overlap in a one-request minute allowance.
		const limiter = limiterFor("day-limit");
		const now = Date.now();
		await limiter.admit(admission(now, { minute: 1, day: 2 }));
		await limiter.admit(admission(now + MINUTE + 1, { minute: 1, day: 2 }));

		// When: a third request arrives one more minute later inside the same rolling day.
		const result = await limiter.admit(admission(now + 2 * MINUTE + 2, { minute: 1, day: 2 }));

		// Then: day exhaustion remains authoritative and reports its precise opening time.
		expect(result).toEqual({ kind: "exhausted", retryAfterSeconds: 86_280 });
	});

	it("expires exact rolling boundaries and old usage without carrying it into a new day", async () => {
		// Given: a key that has consumed its whole one-request minute and day allowance.
		const limiter = limiterFor("expiry");
		const now = Date.now();
		await limiter.admit(admission(now, { minute: 1, day: 1 }));

		// When: requests arrive at the minute and two-day expiry boundaries.
		const afterMinute = await limiter.admit(admission(now + MINUTE, { minute: 1, day: 2 }));
		const afterRetention = await limiter.admit(admission(now + 2 * DAY, { minute: 1, day: 2 }));

		// Then: boundary-expired records cannot exhaust either current rolling window.
		expect(afterMinute).toEqual({ kind: "allowed" });
		expect(afterRetention).toEqual({ kind: "allowed" });
	});
});

import {
	env,
	evictDurableObject,
	runDurableObjectAlarm,
	runInDurableObject,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	ApiKeyLimitConfigurationError,
	ApiKeyLimitRecordError,
} from "../src/admission/api-key-limiter.js";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

type Admission = {
	readonly admittedAt: number;
	readonly publicId: string;
};

function limiterFor(publicId: string) {
	return env.API_KEY_LIMITER.getByName(publicId);
}

function admission(publicId: string, admittedAt: number): Admission {
	return { publicId, admittedAt };
}

async function seedCanonicalLimits(
	publicId: string,
	limits = { minute: 2, day: 10 },
	limitsVersion = 0,
): Promise<void> {
	await env.DB.prepare(
		"INSERT INTO api_key_records (public_id, minute_limit, day_limit, limits_version) VALUES (?1, ?2, ?3, ?4)",
	)
		.bind(publicId, limits.minute, limits.day, limitsVersion)
		.run();
}

async function updateCanonicalLimits(
	publicId: string,
	limits: { readonly minute: number; readonly day: number },
	limitsVersion: number,
): Promise<void> {
	await env.DB.prepare(
		"UPDATE api_key_records SET minute_limit = ?1, day_limit = ?2, limits_version = ?3 WHERE public_id = ?4",
	)
		.bind(limits.minute, limits.day, limitsVersion, publicId)
		.run();
}

async function admissionErrorName(
	limiter: ReturnType<typeof limiterFor>,
	request: Admission,
): Promise<string | undefined> {
	return runInDurableObject(limiter, async (instance) => {
		try {
			await instance.admit(request);
		} catch (error) {
			if (error instanceof Error) return error.name;
			throw error;
		}
		return undefined;
	});
}

describe("ApiKeyLimiter Durable Object", () => {
	beforeEach(async () => {
		await env.DB.prepare("DROP TABLE IF EXISTS api_key_records").run();
		await env.DB.prepare(`CREATE TABLE api_key_records (
			public_id TEXT PRIMARY KEY NOT NULL,
			minute_limit INTEGER NOT NULL,
			day_limit INTEGER NOT NULL,
			limits_version INTEGER NOT NULL
		)`).run();
	});

	it("authoritatively admits only the configured rolling-minute allowance across concurrent calls", async () => {
		// Given: one API-key object with a two-request rolling-minute allowance.
		const publicId = "concurrent-minute-limit";
		const limiter = limiterFor(publicId);
		await seedCanonicalLimits(publicId);
		const request = admission(publicId, Date.now());

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

	it("rejects an input public ID that differs from the Durable Object name", async () => {
		const objectPublicId = "named-object-public-id";
		const mismatchedPublicId = "mismatched-input-public-id";
		const limiter = limiterFor(objectPublicId);
		await seedCanonicalLimits(objectPublicId);
		await seedCanonicalLimits(mismatchedPublicId);
		const objectName = await runInDurableObject(limiter, (_instance, state) => state.id.name);
		expect(objectName).toBe(objectPublicId);
		expect(await admissionErrorName(limiter, admission(mismatchedPublicId, Date.now()))).toBe(
			"ApiKeyLimiterIdentityError",
		);
	});

	it("uses canonical D1 limits while retaining durable rolling usage", async () => {
		// Given: a key object with two prior admissions and an allowance later raised by D1.
		const publicId = "latest-limits";
		const limiter = limiterFor(publicId);
		const now = Date.now();
		await seedCanonicalLimits(publicId);
		await limiter.admit(admission(publicId, now));
		await limiter.admit(admission(publicId, now + 1_000));

		// When: D1 raises the limit before a later admission through a fresh object stub.
		await updateCanonicalLimits(publicId, { minute: 3, day: 10 }, 1);
		const result = await limiterFor(publicId).admit(admission(publicId, now + 2_000));

		// Then: persisted usage survives the separate binding lookup and the canonical increase is honored.
		expect(result).toEqual({ kind: "allowed" });
	});

	it("denies a delayed v0 admission under canonical D1 v1 limits", async () => {
		// Given: authentication read a version-zero two-request allowance before D1 changed it.
		const publicId = "stale-limit-version";
		const limiter = limiterFor(publicId);
		const now = Date.now();
		await seedCanonicalLimits(publicId);
		const staleSnapshot = await env.DB.prepare(
			"SELECT minute_limit, day_limit, limits_version FROM api_key_records WHERE public_id = ?1",
		)
			.bind(publicId)
			.first();
		expect(staleSnapshot).toEqual({ day_limit: 10, limits_version: 0, minute_limit: 2 });

		// When: D1 commits version one with a lower allowance before the delayed admission arrives.
		await updateCanonicalLimits(publicId, { minute: 1, day: 10 }, 1);
		const first = await limiter.admit(admission(publicId, now));
		const persistedConfig = await runInDurableObject(limiter, (_instance, state) => {
			return state.storage.sql
				.exec<{
					readonly day_limit: number;
					readonly limits_version: number;
					readonly minute_limit: number;
				}>("SELECT limits_version, minute_limit, day_limit FROM api_key_limit_config")
				.one();
		});
		const result = await limiter.admit(admission(publicId, now + 1_000));

		// Then: RPC carried no old values, so both calls use persisted version-one limits.
		expect(first).toEqual({ kind: "allowed" });
		expect(persistedConfig).toEqual({ day_limit: 10, limits_version: 1, minute_limit: 1 });
		expect(result).toEqual({ kind: "exhausted", retryAfterSeconds: 59 });
	});

	it("rejects missing, malformed, and unavailable canonical D1 limit records", async () => {
		const publicId = "canonical-limit-errors";
		const limiter = limiterFor(publicId);
		const request = admission(publicId, Date.now());
		expect(await admissionErrorName(limiter, request)).toBe(ApiKeyLimitRecordError.name);
		await seedCanonicalLimits(publicId, { minute: 0, day: 10 });
		expect(await admissionErrorName(limiter, request)).toBe(ApiKeyLimitRecordError.name);
		await env.DB.prepare("DROP TABLE api_key_records").run();
		expect(await admissionErrorName(limiter, request)).toBe(ApiKeyLimitRecordError.name);
	});

	it("fails closed when the same limits version carries conflicting values", async () => {
		// Given: version zero has established a two-request canonical D1 allowance for one key object.
		const publicId = "conflicting-limit-version";
		const limiter = limiterFor(publicId);
		const now = Date.now();
		await seedCanonicalLimits(publicId);
		await limiter.admit(admission(publicId, now));

		// When: D1 has inconsistent values but repeats the same version.
		await updateCanonicalLimits(publicId, { minute: 3, day: 10 }, 0);
		// Then: the object rejects the untrustworthy configuration without charging it.
		const errorName = await runInDurableObject(limiter, async (instance) => {
			try {
				await instance.admit(admission(publicId, now + 1_000));
			} catch (error) {
				if (error instanceof ApiKeyLimitConfigurationError) return error.name;
				throw error;
			}
			return undefined;
		});
		expect(errorName).toBe(ApiKeyLimitConfigurationError.name);
	});

	it("retains the rolling allowance after workerd evicts the object instance", async () => {
		// Given: a running key object that has consumed its one-request minute allowance.
		const publicId = "eviction";
		const limiter = limiterFor(publicId);
		const now = Date.now();
		await seedCanonicalLimits(publicId, { minute: 1, day: 10 });
		await limiter.admit(admission(publicId, now));

		// When: workerd evicts the instance and a replacement receives another request.
		await evictDurableObject(limiter);
		const result = await limiter.admit(admission(publicId, now + 1_000));

		// Then: the reconstructed object reads SQLite state instead of resetting the allowance.
		expect(result).toEqual({ kind: "exhausted", retryAfterSeconds: 59 });
	});

	it("prunes expired SQLite usage and reschedules its alarm", async () => {
		// Given: a key object with one current admission and one usage row beyond its retention horizon.
		const publicId = "alarm";
		const limiter = limiterFor(publicId);
		const now = Date.now();
		await seedCanonicalLimits(publicId);
		await limiter.admit(admission(publicId, now));
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
		const publicId = "day-limit";
		const limiter = limiterFor(publicId);
		const now = Date.now();
		await seedCanonicalLimits(publicId, { minute: 1, day: 2 });
		await limiter.admit(admission(publicId, now));
		await limiter.admit(admission(publicId, now + MINUTE + 1));

		// When: a third request arrives one more minute later inside the same rolling day.
		const result = await limiter.admit(admission(publicId, now + 2 * MINUTE + 2));

		// Then: day exhaustion remains authoritative and reports its precise opening time.
		expect(result).toEqual({ kind: "exhausted", retryAfterSeconds: 86_280 });
	});

	it("expires exact rolling boundaries and old usage without carrying it into a new day", async () => {
		// Given: a key that has consumed its whole one-request minute and day allowance.
		const publicId = "expiry";
		const limiter = limiterFor(publicId);
		const now = Date.now();
		await seedCanonicalLimits(publicId, { minute: 1, day: 1 });
		await limiter.admit(admission(publicId, now));

		// When: D1 increases the day limit and requests arrive at the minute and two-day boundaries.
		await updateCanonicalLimits(publicId, { minute: 1, day: 2 }, 1);
		const afterMinute = await limiter.admit(admission(publicId, now + MINUTE));
		const afterRetention = await limiter.admit(admission(publicId, now + 2 * DAY));

		// Then: boundary-expired records cannot exhaust either current rolling window.
		expect(afterMinute).toEqual({ kind: "allowed" });
		expect(afterRetention).toEqual({ kind: "allowed" });
	});
});

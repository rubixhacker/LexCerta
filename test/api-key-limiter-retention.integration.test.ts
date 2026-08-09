import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const HOUR = 60 * 60 * 1_000;
const RETENTION = 48 * HOUR;

function limiterFor(publicId: string) {
	return env.API_KEY_LIMITER.getByName(publicId);
}

async function seedCanonicalLimits(publicId: string): Promise<void> {
	await env.DB.prepare(
		"INSERT INTO api_key_records (public_id, minute_limit, day_limit, limits_version) VALUES (?1, 1, 1, 0)",
	)
		.bind(publicId)
		.run();
}

describe("ApiKeyLimiter bounded admission retention", () => {
	beforeEach(async () => {
		await env.DB.prepare("DROP TABLE IF EXISTS api_key_records").run();
		await env.DB.prepare(`CREATE TABLE api_key_records (
			public_id TEXT PRIMARY KEY NOT NULL,
			minute_limit INTEGER NOT NULL,
			day_limit INTEGER NOT NULL,
			limits_version INTEGER NOT NULL
		)`).run();
	});

	it("retains a T0-plus-47-hour admission until its own 48-hour deadline", async () => {
		// Given: two otherwise independent rolling-day admissions 47 hours apart.
		const publicId = "per-row-retention";
		const limiter = limiterFor(publicId);
		const startedAt = Date.now();
		const youngerAt = startedAt + 47 * HOUR;
		await seedCanonicalLimits(publicId);
		await limiter.admit({ admittedAt: startedAt, publicId });
		await limiter.admit({ admittedAt: youngerAt, publicId });

		// When: workerd fires the T0 cleanup alarm.
		await runDurableObjectAlarm(limiter);
		const afterFirstAlarm = await runInDurableObject(limiter, async (_instance, state) => ({
			admissions: state.storage.sql
				.exec<{ readonly admitted_at: number }>(
					"SELECT admitted_at FROM api_key_admissions ORDER BY admitted_at",
				)
				.toArray(),
			alarm: await state.storage.getAlarm(),
			configurations: state.storage.sql
				.exec<{ readonly count: number }>("SELECT COUNT(*) AS count FROM api_key_limit_config")
				.one().count,
		}));
		const stillLimited = await limiter.admit({ admittedAt: startedAt + RETENTION, publicId });

		// Then: only the older row is gone, the younger row still exhausts quota, and its deadline is scheduled.
		expect(afterFirstAlarm).toEqual({
			admissions: [{ admitted_at: youngerAt }],
			alarm: youngerAt + RETENTION,
			configurations: 1,
		});
		expect(stillLimited.kind).toBe("exhausted");

		await runDurableObjectAlarm(limiter);
		const afterSecondAlarm = await runInDurableObject(limiter, (_instance, state) => ({
			admissions: state.storage.sql
				.exec<{ readonly count: number }>("SELECT COUNT(*) AS count FROM api_key_admissions")
				.one().count,
			configurations: state.storage.sql
				.exec<{ readonly count: number }>("SELECT COUNT(*) AS count FROM api_key_limit_config")
				.one().count,
		}));
		const afterDeadline = await limiter.admit({ admittedAt: youngerAt + RETENTION, publicId });

		expect(afterSecondAlarm).toEqual({ admissions: 0, configurations: 1 });
		expect(afterDeadline).toEqual({ kind: "allowed" });
	});
});

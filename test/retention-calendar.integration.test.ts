import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import migrationOne from "../migrations/0001_api_key_records.sql?raw";
import migrationTwo from "../migrations/0002_admin_key_lifecycle.sql?raw";
import migrationThree from "../migrations/0003_api_key_limit_version.sql?raw";
import retentionBackfillMigration from "../migrations/0006_backfill_api_key_retention.sql?raw";
import { runScheduledRetention } from "../src/retention/scheduled-retention.js";

const MIGRATION_STATEMENTS = /\s*CREATE TRIGGER[\s\S]*?END;|[^;]+;/gu;

describe("calendar retention migration and sweep", () => {
	beforeEach(async () => {
		for (const table of ["admin_audit_events", "api_key_records", "customers"]) {
			await env.DB.prepare(`DROP TABLE IF EXISTS ${table}`).run();
		}
		await applyMigrations([migrationOne, migrationTwo, migrationThree]);
	});

	it("backfills calendar anniversaries and purges exactly at each deadline", async () => {
		const marchKey = "calendar-march";
		const leapKey = "calendar-leap";
		await insertLegacyKey(marchKey, "2027-03-01T00:00:00.000Z", null, null);
		await insertLegacyKey(leapKey, "2030-01-01T00:00:00.000Z", "2024-02-29T00:00:00.000Z", null);
		await applyMigrations([retentionBackfillMigration]);

		const backfilled = await env.DB.prepare(
			"SELECT public_id, retention_expires_at FROM api_key_records ORDER BY public_id",
		).all<{ readonly public_id: string; readonly retention_expires_at: string }>();
		expect(backfilled.results).toEqual([
			{ public_id: leapKey, retention_expires_at: "2025-03-01T00:00:00.000Z" },
			{ public_id: marchKey, retention_expires_at: "2028-03-01T00:00:00.000Z" },
		]);

		await runScheduledRetention(env.DB, new Date("2025-02-28T23:59:59.999Z"));
		expect(await findKey(leapKey)).not.toBeNull();
		await runScheduledRetention(env.DB, new Date("2025-03-01T00:00:00.000Z"));
		expect(await findKey(leapKey)).toBeNull();

		await runScheduledRetention(env.DB, new Date("2028-02-29T23:59:59.999Z"));
		expect(await findKey(marchKey)).not.toBeNull();
		await runScheduledRetention(env.DB, new Date("2028-03-01T00:00:00.000Z"));
		expect(await findKey(marchKey)).toBeNull();
	});

	it("repairs non-null fixed-day legacy deadlines before exact scheduled purging", async () => {
		const marchKey = "calendar-wrong-march";
		const leapKey = "calendar-wrong-leap";
		await insertLegacyKey(marchKey, "2027-03-01T00:00:00.000Z", null, "2028-02-29T00:00:00.000Z");
		await insertLegacyKey(
			leapKey,
			"2030-01-01T00:00:00.000Z",
			"2024-02-29T00:00:00.000Z",
			"2025-02-28T00:00:00.000Z",
		);
		await applyMigrations([retentionBackfillMigration]);

		const repaired = await env.DB.prepare(
			"SELECT public_id, retention_expires_at FROM api_key_records ORDER BY public_id",
		).all<{ readonly public_id: string; readonly retention_expires_at: string }>();
		expect(repaired.results).toEqual([
			{ public_id: leapKey, retention_expires_at: "2025-03-01T00:00:00.000Z" },
			{ public_id: marchKey, retention_expires_at: "2028-03-01T00:00:00.000Z" },
		]);

		await runScheduledRetention(env.DB, new Date("2025-02-28T23:59:59.999Z"));
		expect(await findKey(leapKey)).not.toBeNull();
		await runScheduledRetention(env.DB, new Date("2025-03-01T00:00:00.000Z"));
		expect(await findKey(leapKey)).toBeNull();
		await runScheduledRetention(env.DB, new Date("2028-02-29T23:59:59.999Z"));
		expect(await findKey(marchKey)).not.toBeNull();
		await runScheduledRetention(env.DB, new Date("2028-03-01T00:00:00.000Z"));
		expect(await findKey(marchKey)).toBeNull();
	});
});

async function applyMigrations(migrations: readonly string[]): Promise<void> {
	for (const migration of migrations) {
		for (const statement of migration.match(MIGRATION_STATEMENTS) ?? []) {
			await env.DB.prepare(statement.trim()).run();
		}
	}
}

async function insertLegacyKey(
	publicId: string,
	expiresAt: string,
	revokedAt: string | null,
	retentionExpiresAt: string | null,
): Promise<void> {
	const customerId = `customer-${publicId}`;
	await env.DB.prepare("INSERT INTO customers (id) VALUES (?1)").bind(customerId).run();
	await env.DB.prepare(
		"INSERT INTO api_key_records (public_id, customer_id, environment, hmac_sha256_hex, status, issued_at, expires_at, revoked_at, retention_expires_at) VALUES (?1, ?2, 'test', ?3, ?4, ?5, ?6, ?7, ?8)",
	)
		.bind(
			publicId,
			customerId,
			"0".repeat(64),
			revokedAt === null ? "active" : "revoked",
			"2024-01-01T00:00:00.000Z",
			expiresAt,
			revokedAt,
			retentionExpiresAt,
		)
		.run();
}

async function findKey(publicId: string): Promise<{ readonly public_id: string } | null> {
	return env.DB.prepare("SELECT public_id FROM api_key_records WHERE public_id = ?1")
		.bind(publicId)
		.first<{ readonly public_id: string }>();
}

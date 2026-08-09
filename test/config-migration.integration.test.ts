import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import apiKeyMigrationSql from "../migrations/0001_api_key_records.sql?raw";
import adminLifecycleMigrationSql from "../migrations/0002_admin_key_lifecycle.sql?raw";
import limitsVersionMigrationSql from "../migrations/0003_api_key_limit_version.sql?raw";

describe("isolated Worker configuration and D1 migrations", () => {
	beforeAll(async () => {
		for (const migration of [
			apiKeyMigrationSql,
			adminLifecycleMigrationSql,
			limitsVersionMigrationSql,
		]) {
			for (const query of splitMigrationStatements(migration)) await env.DB.prepare(query).run();
		}
	});

	it("uses the non-production key boundary for the test environment", () => {
		expect(env.KEY_ENVIRONMENT).toBe("test");
		expect(env.BUILD_ID).toBe("local");
	});

	it("applies the committed API-key migration in workerd D1", async () => {
		const tableColumns = await env.DB.prepare(
			"SELECT name FROM pragma_table_info('api_key_records') ORDER BY cid",
		).all<{ name: string }>();
		const indexes = await env.DB.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'api_key_records' ORDER BY name",
		).all<{ name: string }>();

		expect(tableColumns.results.map((column) => column.name)).toEqual([
			"public_id",
			"customer_id",
			"environment",
			"hmac_sha256_hex",
			"status",
			"issued_at",
			"expires_at",
			"revoked_at",
			"rotation_parent_id",
			"rotation_overlap_until",
			"minute_limit",
			"day_limit",
			"last_used_at",
			"retention_expires_at",
			"limits_version",
		]);
		expect(
			indexes.results
				.map((index) => index.name)
				.filter((name) => name.startsWith("api_key_records_")),
		).toEqual([
			"api_key_records_active_idx",
			"api_key_records_customer_idx",
			"api_key_records_retention_idx",
		]);

		const validCustomer = `migration-test-${crypto.randomUUID()}`;
		const validPublicId = `migration-${crypto.randomUUID()}`;
		await env.DB.prepare("INSERT INTO customers (id) VALUES (?1)").bind(validCustomer).run();
		await env.DB.prepare(
			"INSERT INTO api_key_records (public_id, customer_id, environment, hmac_sha256_hex, issued_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
		)
			.bind(
				validPublicId,
				validCustomer,
				"test",
				"0".repeat(64),
				"2026-08-09T00:00:00.000Z",
				"2026-08-10T00:00:00.000Z",
			)
			.run();
		const storedVersion = await env.DB.prepare(
			"SELECT limits_version FROM api_key_records WHERE public_id = ?1",
		)
			.bind(validPublicId)
			.first<{ readonly limits_version: number }>();
		expect(storedVersion).toEqual({ limits_version: 0 });
		await expect(
			env.DB.prepare(
				"INSERT INTO api_key_records (public_id, customer_id, environment, hmac_sha256_hex, issued_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
			)
				.bind(
					`${validPublicId}-invalid`,
					validCustomer,
					"unknown",
					"0".repeat(64),
					"2026-08-09T00:00:00.000Z",
					"2026-08-10T00:00:00.000Z",
				)
				.run(),
		).rejects.toThrow();
		await expect(
			env.DB.prepare("UPDATE api_key_records SET limits_version = -1 WHERE public_id = ?1")
				.bind(validPublicId)
				.run(),
		).rejects.toThrow();
		await expect(
			env.DB.prepare(
				"INSERT INTO api_key_records (public_id, customer_id, environment, hmac_sha256_hex, issued_at, expires_at, minute_limit, day_limit) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
			)
				.bind(
					`${validPublicId}-minute-too-large`,
					validCustomer,
					"test",
					"0".repeat(64),
					"2026-08-09T00:00:00.000Z",
					"2026-08-10T00:00:00.000Z",
					601,
					10_000,
				)
				.run(),
		).rejects.toThrow();
		await expect(
			env.DB.prepare(
				"INSERT INTO api_key_records (public_id, customer_id, environment, hmac_sha256_hex, issued_at, expires_at, minute_limit, day_limit) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
			)
				.bind(
					`${validPublicId}-day-too-large`,
					validCustomer,
					"test",
					"0".repeat(64),
					"2026-08-09T00:00:00.000Z",
					"2026-08-10T00:00:00.000Z",
					600,
					10_001,
				)
				.run(),
		).rejects.toThrow();
		await expect(
			env.DB.prepare("UPDATE api_key_records SET minute_limit = 601 WHERE public_id = ?1")
				.bind(validPublicId)
				.run(),
		).rejects.toThrow();
		await expect(
			env.DB.prepare("UPDATE api_key_records SET day_limit = 10001 WHERE public_id = ?1")
				.bind(validPublicId)
				.run(),
		).rejects.toThrow();
	});
});

function splitMigrationStatements(migration: string): readonly string[] {
	return (migration.match(/\s*CREATE TRIGGER[\s\S]*?END;|[^;]+;/g) ?? [])
		.map((statement) => statement.trim())
		.filter(Boolean);
}

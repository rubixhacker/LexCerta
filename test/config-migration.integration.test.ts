import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import migrationSql from "../migrations/0001_api_key_records.sql?raw";

describe("isolated Worker configuration and D1 migrations", () => {
	beforeAll(async () => {
		for (const query of migrationSql
			.split(";")
			.map((sql) => sql.trim())
			.filter(Boolean))
			await env.DB.prepare(query).run();
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
		]);
		expect(
			indexes.results
				.map((index) => index.name)
				.filter((name) => name.startsWith("api_key_records_")),
		).toEqual(["api_key_records_active_idx", "api_key_records_customer_idx"]);

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
	});
});

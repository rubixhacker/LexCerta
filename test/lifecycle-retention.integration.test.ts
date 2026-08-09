import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import apiKeyMigration from "../migrations/0001_api_key_records.sql?raw";
import adminLifecycleMigration from "../migrations/0002_admin_key_lifecycle.sql?raw";
import { runScheduledRetention } from "../src/retention/scheduled-retention.js";

const NOW = new Date("2027-08-09T00:00:00.000Z");

describe("D1 lifecycle retention", () => {
	beforeAll(async () => {
		for (const migration of [apiKeyMigration, adminLifecycleMigration]) {
			for (const statement of splitMigrationStatements(migration)) {
				await env.DB.prepare(statement).run();
			}
		}
	});

	it("deletes due lifecycle tombstones and audits while preserving records not yet due", async () => {
		// Given: due expired and revoked keys plus an active key with a future retention deadline.
		const suffix = crypto.randomUUID();
		const expiredCustomerId = `expired-${suffix}`;
		const revokedCustomerId = `revoked-${suffix}`;
		const futureCustomerId = `future-${suffix}`;
		const expiredKeyId = `expired-${suffix}`;
		const revokedKeyId = `revoked-${suffix}`;
		const futureKeyId = `future-${suffix}`;
		for (const customerId of [expiredCustomerId, revokedCustomerId, futureCustomerId]) {
			await env.DB.prepare("INSERT INTO customers (id) VALUES (?1)").bind(customerId).run();
		}
		await insertKey({
			customerId: expiredCustomerId,
			expiresAt: "2026-08-09T00:00:00.000Z",
			keyId: expiredKeyId,
			retentionExpiresAt: NOW.toISOString(),
			status: "active",
		});
		await insertKey({
			customerId: revokedCustomerId,
			expiresAt: "2099-01-01T00:00:00.000Z",
			keyId: revokedKeyId,
			retentionExpiresAt: NOW.toISOString(),
			status: "revoked",
		});
		await insertKey({
			customerId: futureCustomerId,
			expiresAt: "2099-01-01T00:00:00.000Z",
			keyId: futureKeyId,
			retentionExpiresAt: "2027-08-09T00:00:00.001Z",
			status: "active",
		});
		for (const [auditId, customerId, keyId, retentionExpiresAt] of [
			["expired", expiredCustomerId, expiredKeyId, NOW.toISOString()],
			["revoked", revokedCustomerId, revokedKeyId, NOW.toISOString()],
			["future", futureCustomerId, futureKeyId, "2027-08-09T00:00:00.001Z"],
		] as const) {
			await env.DB.prepare(
				"INSERT INTO admin_audit_events (id, action, actor_subject, customer_id, public_id, environment, occurred_at, retention_expires_at, metadata_json) VALUES (?1, 'key_issued', 'operator', ?2, ?3, 'test', ?4, ?5, '{}')",
			)
				.bind(
					`audit-${auditId}-${suffix}`,
					customerId,
					keyId,
					NOW.toISOString(),
					retentionExpiresAt,
				)
				.run();
		}

		// When: the scheduled retention sweep runs at the exact one-year boundary.
		await runScheduledRetention(env.DB, NOW);

		// Then: all due lifecycle records and their Customers are removed at the shared deadline.
		const survivingKeys = await env.DB.prepare(
			"SELECT public_id FROM api_key_records WHERE public_id IN (?1, ?2, ?3) ORDER BY public_id",
		)
			.bind(expiredKeyId, revokedKeyId, futureKeyId)
			.all<{ readonly public_id: string }>();
		expect(survivingKeys.results).toEqual([{ public_id: futureKeyId }]);
		const survivingAudits = await env.DB.prepare(
			"SELECT public_id FROM admin_audit_events WHERE public_id IN (?1, ?2, ?3) ORDER BY public_id",
		)
			.bind(expiredKeyId, revokedKeyId, futureKeyId)
			.all<{ readonly public_id: string }>();
		expect(survivingAudits.results).toEqual([{ public_id: futureKeyId }]);
		const survivingCustomers = await env.DB.prepare(
			"SELECT id FROM customers WHERE id IN (?1, ?2, ?3) ORDER BY id",
		)
			.bind(expiredCustomerId, revokedCustomerId, futureCustomerId)
			.all<{ readonly id: string }>();
		expect(survivingCustomers.results).toEqual([{ id: futureCustomerId }]);
	});

	it("deletes a Customer at its maximum linked lifecycle deadline", async () => {
		// Given: rotation lineage and its audit retain a Customer until their shared final deadline.
		const suffix = crypto.randomUUID();
		const customerId = `tombstone-${suffix}`;
		const parentKeyId = `tombstone-parent-${suffix}`;
		const childKeyId = `tombstone-child-${suffix}`;
		await env.DB.prepare("INSERT INTO customers (id) VALUES (?1)").bind(customerId).run();
		await insertKey({
			customerId,
			expiresAt: "2026-08-09T00:00:00.000Z",
			keyId: parentKeyId,
			retentionExpiresAt: "2027-08-08T00:00:00.000Z",
			status: "active",
		});
		await insertKey({
			customerId,
			expiresAt: "2026-08-09T00:00:00.000Z",
			keyId: childKeyId,
			retentionExpiresAt: NOW.toISOString(),
			rotationParentId: parentKeyId,
			status: "active",
		});
		await env.DB.prepare(
			"INSERT INTO admin_audit_events (id, action, actor_subject, customer_id, public_id, environment, occurred_at, retention_expires_at, metadata_json) VALUES (?1, 'key_issued', 'operator', ?2, ?3, 'test', ?4, ?5, '{}')",
		)
			.bind(
				`audit-tombstone-${suffix}`,
				customerId,
				childKeyId,
				NOW.toISOString(),
				NOW.toISOString(),
			)
			.run();

		// When: the sweep runs one millisecond before and then at the final lifecycle deadline.
		const beforeDeadline = new Date("2027-08-08T23:59:59.999Z");
		await runScheduledRetention(env.DB, beforeDeadline);
		const retained = await env.DB.prepare("SELECT id FROM customers WHERE id = ?1")
			.bind(customerId)
			.first<{ readonly id: string }>();
		expect(retained).toEqual({ id: customerId });

		await runScheduledRetention(env.DB, NOW);
		const deleted = await env.DB.prepare("SELECT id FROM customers WHERE id = ?1")
			.bind(customerId)
			.first();
		expect(deleted).toBeNull();
	});

	it("deletes a due parent while preserving its non-due rotation successor", async () => {
		// Given: a successor still points at a parent whose lifecycle retention has elapsed.
		const suffix = crypto.randomUUID();
		const customerId = `rotation-${suffix}`;
		const parentId = `parent-${suffix}`;
		const childId = `child-${suffix}`;
		await env.DB.prepare("INSERT INTO customers (id) VALUES (?1)").bind(customerId).run();
		await insertKey({
			customerId,
			expiresAt: "2026-08-09T00:00:00.000Z",
			keyId: parentId,
			retentionExpiresAt: NOW.toISOString(),
			status: "active",
		});
		await insertKey({
			customerId,
			expiresAt: "2099-01-01T00:00:00.000Z",
			keyId: childId,
			retentionExpiresAt: "2099-01-01T00:00:00.000Z",
			rotationParentId: parentId,
			status: "active",
		});

		// When: the due parent is purged.
		await runScheduledRetention(env.DB, NOW);

		// Then: the successor remains authorized history-free rather than blocking deletion.
		const child = await env.DB.prepare(
			"SELECT rotation_parent_id FROM api_key_records WHERE public_id = ?1",
		)
			.bind(childId)
			.first<{ readonly rotation_parent_id: string | null }>();
		expect(child).toEqual({ rotation_parent_id: null });
		const parent = await env.DB.prepare(
			"SELECT public_id FROM api_key_records WHERE public_id = ?1",
		)
			.bind(parentId)
			.first();
		expect(parent).toBeNull();
	});
});

type KeyFixture = {
	readonly customerId: string;
	readonly expiresAt: string;
	readonly keyId: string;
	readonly retentionExpiresAt: string;
	readonly rotationParentId?: string;
	readonly status: "active" | "revoked";
};

async function insertKey(input: KeyFixture): Promise<void> {
	await env.DB.prepare(
		"INSERT INTO api_key_records (public_id, customer_id, environment, hmac_sha256_hex, status, issued_at, expires_at, revoked_at, rotation_parent_id, minute_limit, day_limit, retention_expires_at) VALUES (?1, ?2, 'test', ?3, ?4, ?5, ?6, ?7, ?8, 1, 1, ?9)",
	)
		.bind(
			input.keyId,
			input.customerId,
			"0".repeat(64),
			input.status,
			NOW.toISOString(),
			input.expiresAt,
			input.status === "revoked" ? NOW.toISOString() : null,
			input.rotationParentId ?? null,
			input.retentionExpiresAt,
		)
		.run();
}

function splitMigrationStatements(migration: string): readonly string[] {
	return (migration.match(/\s*CREATE TRIGGER[\s\S]*?END;|[^;]+;/g) ?? [])
		.map((statement) => statement.trim())
		.filter(Boolean);
}

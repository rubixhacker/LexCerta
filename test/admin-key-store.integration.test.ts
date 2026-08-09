import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import migrationOne from "../migrations/0001_api_key_records.sql?raw";
import migrationTwo from "../migrations/0002_admin_key_lifecycle.sql?raw";
import type { ApiKeyLifecycleRecord, SanitizedAuditEvent } from "../src/admin/key-lifecycle";
import {
	type AdminKeyIssue,
	type AdminKeyLimitChange,
	type AdminKeyRevocation,
	type AdminKeyRotation,
	AdminKeyRotationConflictError,
	createAdminKeyStore,
} from "../src/admin/key-store";
import { createApiKeyPublicId } from "../src/auth/api-key";

const now = "2026-08-09T12:00:00.000Z";
const retention = "2027-11-07T12:00:00.000Z";
const issuePublicId = createApiKeyPublicId("key-issue");
const rotatedPublicId = createApiKeyPublicId("key-rotated");

async function applyMigration(sql: string): Promise<void> {
	for (const query of sql
		.split(";")
		.map((statement) => statement.trim())
		.filter(Boolean)) {
		await env.DB.prepare(query).run();
	}
}

function makeKey(publicId: ApiKeyLifecycleRecord["publicId"]): ApiKeyLifecycleRecord {
	return {
		customerId: "customer-issue",
		environment: "test",
		expiresAt: "2026-11-07T12:00:00.000Z",
		issuedAt: now,
		limits: { minute: 60, day: 1000 },
		publicId,
		revokedAt: null,
		rotationOverlapUntil: null,
		rotationParentId: null,
		status: "active",
	};
}

function makeAudit(
	action: SanitizedAuditEvent["action"],
	publicId: ApiKeyLifecycleRecord["publicId"],
): SanitizedAuditEvent {
	return {
		action,
		actorSubject: "operator@example.invalid",
		customerId: "customer-issue",
		keyPublicId: publicId,
		occurredAt: now,
	};
}

function makeRotation(
	publicId: ApiKeyLifecycleRecord["publicId"],
	hmacSha256Hex: string,
): AdminKeyRotation {
	const overlap = "2026-08-16T12:00:00.000Z";
	return {
		key: { ...makeKey(publicId), rotationParentId: issuePublicId },
		priorKey: { ...issuedKey, expiresAt: overlap, rotationOverlapUntil: overlap },
		hmacSha256Hex,
		audit: makeAudit("key_rotated", publicId),
	};
}

const issuedKey = makeKey(issuePublicId);
const issue: AdminKeyIssue = {
	key: issuedKey,
	hmacSha256Hex: "a".repeat(64),
	audit: makeAudit("key_issued", issuePublicId),
};

describe("AdminKeyStore against workerd D1", () => {
	beforeEach(async () => {
		await env.DB.prepare("DROP TABLE IF EXISTS admin_audit_events").run();
		await env.DB.prepare("DROP TABLE IF EXISTS api_key_records").run();
		await env.DB.prepare("DROP TABLE IF EXISTS customers").run();
		await applyMigration(migrationOne);
		await applyMigration(migrationTwo);
	});

	it("persists an issued key without a plaintext credential", async () => {
		const store = createAdminKeyStore(env.DB);

		await store.issue(issue);

		const row = await env.DB.prepare(
			"SELECT public_id, customer_id, hmac_sha256_hex, status, rotation_parent_id, rotation_overlap_until, minute_limit, day_limit, retention_expires_at FROM api_key_records WHERE public_id = ?1",
		)
			.bind(issuePublicId)
			.first<Record<string, unknown>>();
		const event = await env.DB.prepare(
			"SELECT action, actor_subject, public_id, metadata_json FROM admin_audit_events WHERE public_id = ?1",
		)
			.bind(issuePublicId)
			.first<Record<string, unknown>>();

		expect(row).toMatchObject({
			public_id: issuePublicId,
			customer_id: issuedKey.customerId,
			hmac_sha256_hex: issue.hmacSha256Hex,
			status: "active",
			rotation_parent_id: null,
			rotation_overlap_until: null,
			minute_limit: issuedKey.limits.minute,
			day_limit: issuedKey.limits.day,
			retention_expires_at: retention,
		});
		expect(JSON.stringify(row)).not.toContain("lc_test_");
		expect(event).toMatchObject({
			action: "key_issued",
			actor_subject: issue.audit.actorSubject,
			public_id: issuePublicId,
			metadata_json: "{}",
		});
		expect(JSON.stringify(event)).not.toContain("secret");
	});

	it("persists rotation lineage and bounded overlap atomically", async () => {
		const store = createAdminKeyStore(env.DB);
		await store.issue(issue);
		const rotation = makeRotation(rotatedPublicId, "b".repeat(64));

		await store.rotate(rotation);

		const rows = await env.DB.prepare(
			"SELECT public_id, rotation_parent_id FROM api_key_records WHERE customer_id = ?1 ORDER BY public_id",
		)
			.bind(issuedKey.customerId)
			.all<{ public_id: string; rotation_parent_id: string | null }>();
		expect(rows.results).toContainEqual({
			public_id: "key-rotated",
			rotation_parent_id: "key-issue",
		});
	});

	it("does not create a child or audit when the rotation parent is unavailable", async () => {
		const store = createAdminKeyStore(env.DB);
		const missingParent = createApiKeyPublicId("key-missing-parent");
		const child = createApiKeyPublicId("key-no-child");
		const rotation: AdminKeyRotation = {
			key: { ...makeKey(child), rotationParentId: missingParent },
			priorKey: { ...makeKey(missingParent) },
			hmacSha256Hex: "c".repeat(64),
			audit: makeAudit("key_rotated", child),
		};

		await expect(store.rotate(rotation)).rejects.toThrow();

		const persistedChild = await env.DB.prepare(
			"SELECT public_id FROM api_key_records WHERE public_id = ?1",
		)
			.bind(child)
			.first();
		const persistedAudit = await env.DB.prepare(
			"SELECT id FROM admin_audit_events WHERE public_id = ?1",
		)
			.bind(child)
			.first();
		expect(persistedChild).toBeNull();
		expect(persistedAudit).toBeNull();
	});

	it("allows only one concurrent replacement from a parent", async () => {
		const store = createAdminKeyStore(env.DB);
		await store.issue(issue);
		const firstChild = createApiKeyPublicId("key-concurrent-a");
		const secondChild = createApiKeyPublicId("key-concurrent-b");

		const outcomes = await Promise.allSettled([
			store.rotate(makeRotation(firstChild, "d".repeat(64))),
			store.rotate(makeRotation(secondChild, "e".repeat(64))),
		]);

		const fulfilled = outcomes.filter(
			(outcome): outcome is PromiseFulfilledResult<void> => outcome.status === "fulfilled",
		);
		const rejected = outcomes.find(
			(outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
		);
		expect(fulfilled).toHaveLength(1);
		expect(rejected?.reason).toBeInstanceOf(AdminKeyRotationConflictError);
		const children = await env.DB.prepare(
			"SELECT COUNT(*) AS count FROM api_key_records WHERE rotation_parent_id = ?1",
		)
			.bind(issuePublicId)
			.first<{ count: number }>();
		expect(children?.count).toBe(1);
	});

	it("revokes immediately and records a sanitized audit event", async () => {
		const store = createAdminKeyStore(env.DB);
		await store.issue(issue);
		await store.rotate(makeRotation(rotatedPublicId, "b".repeat(64)));
		const key: ApiKeyLifecycleRecord = {
			...makeKey(rotatedPublicId),
			rotationParentId: issuePublicId,
		};
		const revocation: AdminKeyRevocation = {
			key: { ...key, revokedAt: now, status: "revoked" },
			audit: makeAudit("key_revoked", rotatedPublicId),
		};

		await store.revoke(revocation);

		const row = await env.DB.prepare(
			"SELECT status, revoked_at, rotation_overlap_until, retention_expires_at FROM api_key_records WHERE public_id = ?1",
		)
			.bind(rotatedPublicId)
			.first<Record<string, unknown>>();
		const event = await env.DB.prepare(
			"SELECT action, metadata_json, retention_expires_at FROM admin_audit_events WHERE public_id = ?1 AND action = 'key_revoked'",
		)
			.bind(rotatedPublicId)
			.first<Record<string, unknown>>();
		expect(row).toMatchObject({
			status: "revoked",
			revoked_at: now,
			rotation_overlap_until: null,
			retention_expires_at: "2027-08-09T12:00:00.000Z",
		});
		expect(event).toMatchObject({
			action: "key_revoked",
			metadata_json: "{}",
			retention_expires_at: "2027-08-09T12:00:00.000Z",
		});
	});

	it("changes limits atomically while preserving the key record", async () => {
		const store = createAdminKeyStore(env.DB);
		await store.issue(issue);
		const change: AdminKeyLimitChange = {
			key: { ...makeKey(issuePublicId), limits: { minute: 12, day: 240 } },
			audit: makeAudit("key_limits_changed", issuePublicId),
		};

		await store.changeLimits(change);

		const row = await env.DB.prepare(
			"SELECT minute_limit, day_limit, hmac_sha256_hex FROM api_key_records WHERE public_id = ?1",
		)
			.bind(issuePublicId)
			.first<Record<string, unknown>>();
		expect(row).toMatchObject({
			minute_limit: 12,
			day_limit: 240,
			hmac_sha256_hex: "a".repeat(64),
		});
	});

	it("rolls back an issue when key insertion fails", async () => {
		const store = createAdminKeyStore(env.DB);
		await store.issue(issue);
		const duplicate: AdminKeyIssue = {
			...issue,
			key: { ...issuedKey, customerId: "customer-rolled-back" },
		};

		await expect(store.issue(duplicate)).rejects.toThrow();

		const customer = await env.DB.prepare("SELECT id FROM customers WHERE id = ?1")
			.bind("customer-rolled-back")
			.first();
		expect(customer).toBeNull();
	});
});

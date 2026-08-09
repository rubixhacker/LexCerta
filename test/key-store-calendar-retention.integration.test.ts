import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import migrationOne from "../migrations/0001_api_key_records.sql?raw";
import migrationTwo from "../migrations/0002_admin_key_lifecycle.sql?raw";
import migrationThree from "../migrations/0003_api_key_limit_version.sql?raw";
import type { ApiKeyLifecycleRecord, SanitizedAuditEvent } from "../src/admin/key-lifecycle.js";
import {
	type AdminKeyIssue,
	type AdminKeyRevocation,
	createAdminKeyStore,
} from "../src/admin/key-store.js";
import { createApiKeyPublicId } from "../src/auth/api-key.js";

const MIGRATION_STATEMENTS = /\s*CREATE TRIGGER[\s\S]*?END;|[^;]+;/gu;

describe("AdminKeyStore calendar retention", () => {
	beforeEach(async () => {
		for (const table of ["admin_audit_events", "api_key_records", "customers"]) {
			await env.DB.prepare(`DROP TABLE IF EXISTS ${table}`).run();
		}
		for (const migration of [migrationOne, migrationTwo, migrationThree]) {
			for (const statement of migration.match(MIGRATION_STATEMENTS) ?? []) {
				await env.DB.prepare(statement.trim()).run();
			}
		}
	});

	it("retains March 1 expirations until the next March 1", async () => {
		const key = makeKey("march-one", "2027-03-01T00:00:00.000Z");
		await createAdminKeyStore(env.DB).issue(makeIssue(key, "key_issued"));

		const retention = await retentionFor(key.publicId, "key_issued");
		expect(retention).toEqual({
			key: "2028-03-01T00:00:00.000Z",
			audit: "2028-03-01T00:00:00.000Z",
		});
	});

	it("uses revocation over expiry and maps a Feb 29 anniversary to March 1", async () => {
		const key = makeKey("february-twenty-ninth", "2030-01-01T00:00:00.000Z");
		const revokedAt = "2024-02-29T00:00:00.000Z";
		const store = createAdminKeyStore(env.DB);
		await store.issue(makeIssue(key, "key_issued"));
		await store.revoke({
			key: { ...key, revokedAt, status: "revoked" },
			audit: makeAudit(key, "key_revoked", revokedAt),
		});

		const retention = await retentionFor(key.publicId, "key_revoked");
		expect(retention).toEqual({
			key: "2025-03-01T00:00:00.000Z",
			audit: "2025-03-01T00:00:00.000Z",
		});
	});
});

function makeKey(id: string, expiresAt: string): ApiKeyLifecycleRecord {
	return {
		customerId: `calendar-${id}`,
		environment: "test",
		expiresAt,
		issuedAt: "2024-01-01T00:00:00.000Z",
		limits: { minute: 60, day: 1_000 },
		publicId: createApiKeyPublicId(id),
		revokedAt: null,
		rotationOverlapUntil: null,
		rotationParentId: null,
		status: "active",
	};
}

function makeIssue(
	key: ApiKeyLifecycleRecord,
	action: SanitizedAuditEvent["action"],
): AdminKeyIssue {
	return {
		key,
		hmacSha256Hex: "a".repeat(64),
		audit: makeAudit(key, action, key.issuedAt),
	};
}

function makeAudit(
	key: ApiKeyLifecycleRecord,
	action: SanitizedAuditEvent["action"],
	occurredAt: string,
): SanitizedAuditEvent {
	return {
		action,
		actorSubject: "operator@example.invalid",
		customerId: key.customerId,
		keyPublicId: key.publicId,
		occurredAt,
	};
}

async function retentionFor(
	publicId: ApiKeyLifecycleRecord["publicId"],
	action: SanitizedAuditEvent["action"],
): Promise<{ readonly key: string; readonly audit: string } | null> {
	const key = await env.DB.prepare(
		"SELECT retention_expires_at FROM api_key_records WHERE public_id = ?1",
	)
		.bind(publicId)
		.first<{ readonly retention_expires_at: string }>();
	const audit = await env.DB.prepare(
		"SELECT retention_expires_at FROM admin_audit_events WHERE public_id = ?1 AND action = ?2",
	)
		.bind(publicId, action)
		.first<{ readonly retention_expires_at: string }>();
	return key === null || audit === null
		? null
		: { key: key.retention_expires_at, audit: audit.retention_expires_at };
}

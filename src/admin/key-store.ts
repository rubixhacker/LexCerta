import type { ApiKeyPublicId } from "../auth/api-key.js";
import type {
	ApiKeyLifecycleRecord,
	ApiKeyLimits,
	KeyEnvironment,
	SanitizedAuditEvent,
} from "./key-lifecycle.js";

export type AdminKeyIssue = {
	readonly key: ApiKeyLifecycleRecord;
	readonly hmacSha256Hex: string;
	readonly audit: SanitizedAuditEvent;
};

export type AdminKeyRotation = AdminKeyIssue & {
	readonly priorKey: ApiKeyLifecycleRecord;
};

export type AdminKeyRevocation = {
	readonly key: ApiKeyLifecycleRecord;
	readonly audit: SanitizedAuditEvent;
};

export type AdminKeyLimitChange = AdminKeyRevocation;

export type StoredAdminKey = ApiKeyLifecycleRecord & {
	readonly hmacSha256Hex: string;
};

export interface AdminKeyStore {
	issue(input: AdminKeyIssue): Promise<void>;
	rotate(input: AdminKeyRotation): Promise<void>;
	revoke(input: AdminKeyRevocation): Promise<void>;
	changeLimits(input: AdminKeyLimitChange): Promise<void>;
	find(publicId: ApiKeyPublicId): Promise<StoredAdminKey | null>;
	purgeExpired(retainedAt: Date): Promise<void>;
}

export function createAdminKeyStore(database: D1Database): AdminKeyStore {
	return {
		issue: async (input) => {
			await database.batch([
				database
					.prepare(
						"INSERT INTO customers (id, retired_at, retention_expires_at) VALUES (?1, NULL, NULL) ON CONFLICT(id) DO UPDATE SET retired_at = NULL, retention_expires_at = NULL",
					)
					.bind(input.key.customerId),
				...keyInsertStatements(database, input),
			]);
		},
		rotate: async (input) => {
			const parent = input.priorKey;
			const child = input.key;
			const results = await database.batch([
				database
					.prepare(
						"INSERT INTO api_key_records (public_id, customer_id, environment, hmac_sha256_hex, status, issued_at, expires_at, rotation_parent_id, rotation_overlap_until, minute_limit, day_limit, retention_expires_at) SELECT ?1, ?2, ?3, ?4, 'active', ?5, ?6, ?7, NULL, ?8, ?9, ?10 WHERE EXISTS (SELECT 1 FROM api_key_records WHERE public_id = ?7 AND customer_id = ?2 AND environment = ?3 AND status = 'active')",
					)
					.bind(
						child.publicId,
						child.customerId,
						child.environment,
						input.hmacSha256Hex,
						child.issuedAt,
						child.expiresAt,
						parent.publicId,
						child.limits.minute,
						child.limits.day,
						retentionAt(child.expiresAt),
					),
				parentUpdateStatement(database, parent, parent.rotationOverlapUntil),
				...auditStatements(database, input.audit, child, {
					status: "active",
					publicId: child.publicId,
				}),
			]);
			if ((results[0]?.meta.changes ?? 0) !== 1) throw new AdminKeyNotFoundError(parent.publicId);
		},
		revoke: async (input) => {
			const key = input.key;
			const revokedAt = key.revokedAt ?? input.audit.occurredAt;
			const results = await database.batch([
				database
					.prepare(
						"UPDATE api_key_records SET status = 'revoked', revoked_at = ?1, rotation_overlap_until = NULL, retention_expires_at = ?2 WHERE public_id = ?3 AND status = 'active'",
					)
					.bind(revokedAt, retentionAt(revokedAt), key.publicId),
				...auditStatements(database, input.audit, key, {
					status: "revoked",
					publicId: key.publicId,
					revokedAt: revokedAt,
				}),
			]);
			if ((results[0]?.meta.changes ?? 0) !== 1) throw new AdminKeyNotFoundError(key.publicId);
		},
		changeLimits: async (input) => {
			const key = input.key;
			const results = await database.batch([
				database
					.prepare(
						"UPDATE api_key_records SET minute_limit = ?1, day_limit = ?2 WHERE public_id = ?3 AND status = 'active'",
					)
					.bind(key.limits.minute, key.limits.day, key.publicId),
				...auditStatements(database, input.audit, key, {
					status: "active",
					publicId: key.publicId,
				}),
			]);
			if ((results[0]?.meta.changes ?? 0) !== 1) throw new AdminKeyNotFoundError(key.publicId);
		},
		find: async (publicId) => {
			const row = await database
				.prepare(
					"SELECT customer_id, environment, expires_at, issued_at, minute_limit, day_limit, public_id, revoked_at, rotation_overlap_until, rotation_parent_id, status, hmac_sha256_hex FROM api_key_records WHERE public_id = ?1 LIMIT 1",
				)
				.bind(publicId)
				.first<StoredKeyRow>();
			return row === null ? null : fromStoredRow(row);
		},
		purgeExpired: async (retainedAt) => {
			const timestamp = retainedAt.toISOString();
			await database.batch([
				database
					.prepare("DELETE FROM admin_audit_events WHERE retention_expires_at <= ?1")
					.bind(timestamp),
				database
					.prepare("DELETE FROM api_key_records WHERE retention_expires_at <= ?1")
					.bind(timestamp),
			]);
		},
	};
}

export class AdminKeyNotFoundError extends Error {
	readonly name = "AdminKeyNotFoundError";

	constructor(readonly publicId: ApiKeyPublicId) {
		super(`api key ${publicId} is unavailable`);
	}
}

function keyInsertStatements(
	database: D1Database,
	input: AdminKeyIssue,
): readonly D1PreparedStatement[] {
	const key = input.key;
	return [
		database
			.prepare(
				"INSERT INTO api_key_records (public_id, customer_id, environment, hmac_sha256_hex, status, issued_at, expires_at, rotation_parent_id, rotation_overlap_until, minute_limit, day_limit, retention_expires_at) VALUES (?1, ?2, ?3, ?4, 'active', ?5, ?6, NULL, NULL, ?7, ?8, ?9)",
			)
			.bind(
				key.publicId,
				key.customerId,
				key.environment,
				input.hmacSha256Hex,
				key.issuedAt,
				key.expiresAt,
				key.limits.minute,
				key.limits.day,
				retentionAt(key.expiresAt),
			),
		...auditStatements(database, input.audit, key, { status: "active", publicId: key.publicId }),
	];
}

function parentUpdateStatement(
	database: D1Database,
	parent: ApiKeyLifecycleRecord,
	overlap: string | null,
): D1PreparedStatement {
	const expiresAt = overlap ?? parent.expiresAt;
	return database
		.prepare(
			"UPDATE api_key_records SET expires_at = ?1, rotation_overlap_until = ?2, retention_expires_at = ?3 WHERE public_id = ?4 AND customer_id = ?5 AND environment = ?6 AND status = 'active'",
		)
		.bind(
			expiresAt,
			overlap,
			retentionAt(expiresAt),
			parent.publicId,
			parent.customerId,
			parent.environment,
		);
}

function auditStatements(
	database: D1Database,
	audit: SanitizedAuditEvent,
	key: ApiKeyLifecycleRecord,
	guard: AuditGuard,
): readonly D1PreparedStatement[] {
	const metadata =
		audit.action === "key_rotated" && key.rotationParentId !== null
			? JSON.stringify({ rotationParentId: key.rotationParentId })
			: "{}";
	const auditRetention =
		audit.action === "key_revoked" ? retentionAt(audit.occurredAt) : retentionAt(key.expiresAt);
	return [
		database
			.prepare(
				"INSERT INTO admin_audit_events (id, action, actor_subject, customer_id, public_id, environment, occurred_at, retention_expires_at, metadata_json) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9 WHERE EXISTS (SELECT 1 FROM api_key_records WHERE public_id = ?10 AND status = ?11 AND (?12 IS NULL OR revoked_at = ?12))",
			)
			.bind(
				crypto.randomUUID(),
				audit.action,
				sanitizeActor(audit.actorSubject),
				audit.customerId,
				audit.keyPublicId,
				key.environment,
				audit.occurredAt,
				auditRetention,
				metadata,
				guard.publicId,
				guard.status,
				guard.revokedAt ?? null,
			),
	];
}

type AuditGuard = {
	readonly status: "active" | "revoked";
	readonly publicId: ApiKeyPublicId;
	readonly revokedAt?: string;
};

type StoredKeyRow = {
	readonly customer_id: string;
	readonly environment: KeyEnvironment;
	readonly expires_at: string;
	readonly issued_at: string;
	readonly minute_limit: number;
	readonly day_limit: number;
	readonly public_id: ApiKeyPublicId;
	readonly revoked_at: string | null;
	readonly rotation_overlap_until: string | null;
	readonly rotation_parent_id: ApiKeyPublicId | null;
	readonly status: "active" | "revoked";
	readonly hmac_sha256_hex: string;
};

function fromStoredRow(row: StoredKeyRow): StoredAdminKey {
	return {
		customerId: row.customer_id,
		environment: row.environment,
		expiresAt: row.expires_at,
		issuedAt: row.issued_at,
		limits: { minute: row.minute_limit, day: row.day_limit },
		publicId: row.public_id,
		revokedAt: row.revoked_at,
		rotationOverlapUntil: row.rotation_overlap_until,
		rotationParentId: row.rotation_parent_id,
		status: row.status,
		hmacSha256Hex: row.hmac_sha256_hex,
	};
}

function retentionAt(value: string): string {
	return new Date(Date.parse(value) + 365 * 24 * 60 * 60 * 1_000).toISOString();
}

function sanitizeActor(value: string): string {
	return Array.from(value)
		.filter((character) => character >= " " && character !== "\u007f")
		.join("")
		.slice(0, 256);
}

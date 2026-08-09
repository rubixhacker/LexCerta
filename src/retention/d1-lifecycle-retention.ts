const RETENTION_SWEEP_STATEMENTS = 5;

export type LifecycleRetentionPurge = {
	readonly adminAuditEvents: number;
	readonly apiKeyRecords: number;
	readonly customers: number;
};

export async function purgeExpiredLifecycleRecords(
	database: D1Database,
	now: Date,
): Promise<LifecycleRetentionPurge> {
	const dueAt = now.toISOString();
	const result = await database.batch([
		database
			.prepare(
				"UPDATE customers SET retired_at = ?1, retention_expires_at = MAX(COALESCE((SELECT MAX(retention_expires_at) FROM api_key_records WHERE api_key_records.customer_id = customers.id), ?1), COALESCE((SELECT MAX(retention_expires_at) FROM admin_audit_events WHERE admin_audit_events.customer_id = customers.id), ?1)) WHERE retention_expires_at IS NULL AND NOT EXISTS (SELECT 1 FROM api_key_records WHERE api_key_records.customer_id = customers.id AND (api_key_records.retention_expires_at IS NULL OR api_key_records.retention_expires_at > ?1 OR (api_key_records.revoked_at IS NULL AND api_key_records.expires_at > ?1))) AND NOT EXISTS (SELECT 1 FROM admin_audit_events WHERE admin_audit_events.customer_id = customers.id AND admin_audit_events.retention_expires_at > ?1)",
			)
			.bind(dueAt),
		database.prepare("DELETE FROM admin_audit_events WHERE retention_expires_at <= ?1").bind(dueAt),
		database
			.prepare(
				"UPDATE api_key_records SET rotation_parent_id = NULL WHERE rotation_parent_id IN (SELECT public_id FROM api_key_records WHERE retention_expires_at <= ?1 AND (revoked_at IS NOT NULL OR expires_at <= ?1))",
			)
			.bind(dueAt),
		database
			.prepare(
				"DELETE FROM api_key_records WHERE retention_expires_at <= ?1 AND (revoked_at IS NOT NULL OR expires_at <= ?1)",
			)
			.bind(dueAt),
		database
			.prepare(
				"DELETE FROM customers WHERE retention_expires_at <= ?1 AND NOT EXISTS (SELECT 1 FROM api_key_records WHERE api_key_records.customer_id = customers.id) AND NOT EXISTS (SELECT 1 FROM admin_audit_events WHERE admin_audit_events.customer_id = customers.id)",
			)
			.bind(dueAt),
	]);
	if (result.length !== RETENTION_SWEEP_STATEMENTS) {
		throw new LifecycleRetentionPurgeError(result.length);
	}
	return {
		adminAuditEvents: result[1]?.meta.changes ?? 0,
		apiKeyRecords: result[3]?.meta.changes ?? 0,
		customers: result[4]?.meta.changes ?? 0,
	};
}

export class LifecycleRetentionPurgeError extends Error {
	readonly name = "LifecycleRetentionPurgeError";

	constructor(readonly completedStatements: number) {
		super(`retention sweep completed ${completedStatements} statements`);
	}
}

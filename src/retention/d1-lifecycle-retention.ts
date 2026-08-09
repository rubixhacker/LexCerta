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
				"UPDATE customers SET retired_at = ?1, retention_expires_at = ?1 WHERE retention_expires_at IS NULL AND NOT EXISTS (SELECT 1 FROM api_key_records WHERE api_key_records.customer_id = customers.id) AND NOT EXISTS (SELECT 1 FROM admin_audit_events WHERE admin_audit_events.customer_id = customers.id)",
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
		adminAuditEvents: result[0]?.meta.changes ?? 0,
		apiKeyRecords: result[2]?.meta.changes ?? 0,
		customers: result[4]?.meta.changes ?? 0,
	};
}

export class LifecycleRetentionPurgeError extends Error {
	readonly name = "LifecycleRetentionPurgeError";

	constructor(readonly completedStatements: number) {
		super(`retention sweep completed ${completedStatements} statements`);
	}
}

import type { PgTransaction, TransactionDatabase } from "./database.js";

export async function purgePostgresRollingWindows(database: TransactionDatabase, batchSize = 500) {
	validateBatchSize(batchSize);
	return database.transaction((transaction) => purgeWindows(transaction, batchSize));
}

async function purgeWindows(transaction: PgTransaction, batchSize: number) {
	const admissions = await transaction.query(
		"DELETE FROM lexcerta.key_admissions WHERE ctid IN (SELECT ctid FROM lexcerta.key_admissions WHERE admitted_at <= clock_timestamp() - interval '48 hours' ORDER BY admitted_at LIMIT $1 FOR UPDATE SKIP LOCKED)",
		[batchSize],
	);
	const attempts = await transaction.query(
		"DELETE FROM lexcerta.upstream_attempts WHERE (credential_id, token) IN (SELECT credential_id, token FROM lexcerta.upstream_attempts WHERE reserved_at <= clock_timestamp() - interval '48 hours' ORDER BY reserved_at LIMIT $1 FOR UPDATE SKIP LOCKED)",
		[batchSize],
	);
	return { admissions: admissions.rowCount ?? 0, attempts: attempts.rowCount ?? 0 };
}

function validateBatchSize(batchSize: number) {
	if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 500)
		throw new RangeError("invalid retention batch");
}

// The scheduled job uses a separate identity. Every bounded batch is SQL-only
// and atomic; an interrupted or duplicate invocation can retry the same sweep.
export async function purgePostgresRetention(database: TransactionDatabase, batchSize = 500) {
	validateBatchSize(batchSize);
	return database.transaction(async (transaction) => {
		const windows = await purgeWindows(transaction, batchSize);
		const audit = await transaction.query(
			"DELETE FROM lexcerta.admin_audit_events WHERE id IN (SELECT id FROM lexcerta.admin_audit_events WHERE retention_expires_at <= clock_timestamp() ORDER BY retention_expires_at LIMIT $1 FOR UPDATE SKIP LOCKED)",
			[batchSize],
		);
		const keys = await transaction.query(
			"DELETE FROM lexcerta.api_keys WHERE public_id IN (SELECT public_id FROM lexcerta.api_keys WHERE retention_expires_at <= clock_timestamp() AND (status = 'revoked' OR expires_at <= clock_timestamp()) ORDER BY retention_expires_at LIMIT $1 FOR UPDATE SKIP LOCKED)",
			[batchSize],
		);
		// Customer identity is retained while any credential or audit record needs
		// it. Issuance locks/upserts the same row and clears retirement atomically.
		await transaction.query(
			"UPDATE lexcerta.customers SET retired_at = clock_timestamp(), retention_expires_at = clock_timestamp() WHERE id IN (SELECT id FROM lexcerta.customers c WHERE retired_at IS NULL AND NOT EXISTS (SELECT 1 FROM lexcerta.api_keys k WHERE k.customer_id = c.id) AND NOT EXISTS (SELECT 1 FROM lexcerta.admin_audit_events a WHERE a.customer_id = c.id) ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)",
			[batchSize],
		);
		const customers = await transaction.query(
			"DELETE FROM lexcerta.customers WHERE id IN (SELECT id FROM lexcerta.customers c WHERE retention_expires_at <= clock_timestamp() AND NOT EXISTS (SELECT 1 FROM lexcerta.api_keys k WHERE k.customer_id = c.id) AND NOT EXISTS (SELECT 1 FROM lexcerta.admin_audit_events a WHERE a.customer_id = c.id) ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)",
			[batchSize],
		);
		return {
			...windows,
			audit: audit.rowCount ?? 0,
			keys: keys.rowCount ?? 0,
			customers: customers.rowCount ?? 0,
		};
	});
}

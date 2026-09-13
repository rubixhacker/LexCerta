import type { PoolClient } from "pg";

export type DatabaseRoles = Readonly<Record<"public" | "admin" | "job" | "migrator", string>>;
export const DATABASE_CONNECTION_LIMITS = { public: 30, admin: 4, job: 2, migrator: 1 } as const;

export function databaseRoles(environment: "staging" | "production"): DatabaseRoles {
	if (environment !== "staging" && environment !== "production")
		throw new Error("Database environment unavailable");
	return {
		public: `lexcerta_${environment}_public`,
		admin: `lexcerta_${environment}_admin`,
		job: `lexcerta_${environment}_job`,
		migrator: `lexcerta_${environment}_migrator`,
	};
}

export function validateDatabaseRoles(roles: DatabaseRoles, expectedMigrator: string): void {
	const names = Object.values(roles);
	if (
		names.length !== 4 ||
		new Set(names).size !== 4 ||
		roles.migrator !== expectedMigrator ||
		!names.every((name) => /^[a-z][a-z0-9_]{0,62}$/.test(name))
	)
		throw new Error("Database role configuration unavailable");
}

// Run only under the migration advisory lock, after the checksummed schema is
// current. No default grant gives a newly added table to an application role.
export async function applyDatabaseGrants(
	client: PoolClient,
	roles: DatabaseRoles,
	options: { readonly sealForRecovery?: "staging" | "production" } = {},
) {
	validateDatabaseRoles(roles, roles.migrator);
	if (
		options.sealForRecovery !== undefined &&
		!["staging", "production"].includes(options.sealForRecovery)
	)
		throw new Error("Recovery environment unavailable");
	const identity = (
		await client.query<{ role: string; database: string; database_owner: string }>(
			"SELECT current_user AS role, current_database() AS database, (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()) AS database_owner",
		)
	).rows[0];
	if (identity?.role !== roles.migrator || identity.database_owner !== roles.migrator)
		throw new Error("Grants require the database-owning migration identity");
	const identities = await client.query<{
		rolname: string;
		elevated: boolean;
		rolconnlimit: number;
	}>(
		`
		SELECT a.rolname, a.rolconnlimit, EXISTS (
			SELECT 1 FROM pg_roles inherited
			WHERE pg_has_role(a.oid, inherited.oid, 'MEMBER')
			AND (inherited.rolsuper OR inherited.rolcreaterole OR inherited.rolcreatedb
				OR inherited.rolreplication OR inherited.rolbypassrls OR inherited.rolname = 'neon_superuser'
				OR (inherited.oid <> a.oid AND NOT (a.rolname = $2 AND inherited.rolname = 'pg_database_owner')))
		) AS elevated FROM pg_roles a WHERE a.rolname = ANY($1::text[])
	`,
		[Object.values(roles), roles.migrator],
	);
	if (identities.rowCount !== 4 || identities.rows.some((role) => role.elevated))
		throw new Error("Database roles must be isolated restricted identities");
	for (const purpose of ["public", "admin", "job", "migrator"] as const)
		if (
			identities.rows.find((role) => role.rolname === roles[purpose])?.rolconnlimit !==
			DATABASE_CONNECTION_LIMITS[purpose]
		)
			throw new Error("Database role connection limits are not configured");
	const capacity = (
		await client.query<{ available: number }>(
			"SELECT current_setting('max_connections')::int - current_setting('superuser_reserved_connections')::int - current_setting('reserved_connections')::int AS available",
		)
	).rows[0]?.available;
	const requiredConnections = Object.values(DATABASE_CONNECTION_LIMITS).reduce(
		(sum, limit) => sum + limit,
		20,
	);
	if (capacity === undefined || capacity < requiredConnections)
		throw new Error("Database requires twenty connections of recovery headroom");
	const runtime = [roles.public, roles.admin, roles.job].map(identifier).join(", ");
	const grantees = `PUBLIC, ${runtime}`;
	const pub = identifier(roles.public);
	const admin = identifier(roles.admin);
	const job = identifier(roles.job);
	await client.query("BEGIN");
	try {
		await client.query("SET LOCAL lock_timeout = '5s'");
		await client.query("SET LOCAL statement_timeout = '30s'");
		const recovery = await client.query<{ sealed_at: Date | null; environment: string | null }>(
			"SELECT sealed_at, environment FROM lexcerta.recovery_control WHERE singleton FOR UPDATE",
		);
		if (recovery.rowCount !== 1) throw new Error("Recovery authority unavailable");
		if (options.sealForRecovery !== undefined) {
			if (
				recovery.rows[0]?.environment !== null &&
				recovery.rows[0]?.environment !== options.sealForRecovery
			)
				throw new Error("Recovery environment unavailable");
			await client.query(
				"UPDATE lexcerta.recovery_control SET sealed_at = coalesce(sealed_at, clock_timestamp()), environment = $1 WHERE singleton",
				[options.sealForRecovery],
			);
		}
		const sealed = options.sealForRecovery !== undefined || recovery.rows[0]?.sealed_at !== null;
		await client.query(`REVOKE ALL ON DATABASE ${identifier(identity.database)} FROM ${grantees}`);
		// An unchanged migration repairs grants but must never reopen a restore.
		if (!sealed)
			await client.query(
				`GRANT CONNECT ON DATABASE ${identifier(identity.database)} TO ${runtime}`,
			);
		await client.query(`REVOKE ALL ON SCHEMA public, lexcerta FROM ${grantees}`);
		await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA lexcerta FROM ${grantees}`);
		await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA lexcerta FROM ${grantees}`);
		await client.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA lexcerta FROM ${grantees}`);
		// Table REVOKE does not remove earlier column grants. Clear those too.
		const columns = await client.query<{ relname: string; columns: string[] }>(`
			SELECT c.relname, array_agg(a.attname::text ORDER BY a.attnum) AS columns
			FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
			JOIN pg_attribute a ON a.attrelid = c.oid
			WHERE n.nspname = 'lexcerta' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
			AND a.attnum > 0 AND NOT a.attisdropped GROUP BY c.relname
		`);
		for (const table of columns.rows)
			await client.query(
				`REVOKE ALL (${table.columns.map(identifier).join(", ")}) ON lexcerta.${identifier(table.relname)} FROM ${grantees}`,
			);
		await client.query(`ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM ${grantees}`);
		await client.query(`ALTER DEFAULT PRIVILEGES REVOKE ALL ON TABLES FROM ${grantees}`);
		await client.query(`ALTER DEFAULT PRIVILEGES REVOKE ALL ON SEQUENCES FROM ${grantees}`);
		await client.query(
			`ALTER DEFAULT PRIVILEGES IN SCHEMA lexcerta REVOKE EXECUTE ON FUNCTIONS FROM ${grantees}`,
		);
		await client.query(
			`ALTER DEFAULT PRIVILEGES IN SCHEMA lexcerta REVOKE ALL ON TABLES FROM ${grantees}`,
		);
		await client.query(
			`ALTER DEFAULT PRIVILEGES IN SCHEMA lexcerta REVOKE ALL ON SEQUENCES FROM ${grantees}`,
		);
		if (sealed) {
			// Also remove permissions from already authenticated connections.
			// No routine migration or replay completion grants these back.
			await client.query("COMMIT");
			return;
		}
		const grants = [
			`GRANT USAGE ON SCHEMA lexcerta TO ${runtime}`,
			`GRANT SELECT ON lexcerta.api_keys TO ${pub}`,
			`GRANT SELECT, UPDATE (public_id) ON lexcerta.api_key_admission_locks TO ${pub}`,
			`GRANT SELECT, INSERT ON lexcerta.key_admissions TO ${pub}`,
			`GRANT SELECT, UPDATE (state) ON lexcerta.upstream_budgets TO ${pub}`,
			`GRANT SELECT, INSERT, UPDATE (completed_at) ON lexcerta.upstream_attempts TO ${pub}`,
			`GRANT SELECT, INSERT, UPDATE ON lexcerta.citation_sources TO ${pub}`,
			`GRANT SELECT, INSERT (opinion_id), UPDATE (state, epoch, owner_token, lease_expires_at, body_key, updated_at) ON lexcerta.opinion_sources TO ${pub}`,
			`GRANT SELECT, INSERT, UPDATE, DELETE ON lexcerta.source_objects TO ${pub}`,
			`GRANT SELECT ON lexcerta.orphan_object_deletions TO ${pub}`,
			`GRANT SELECT, UPDATE (singleton) ON lexcerta.cache_capacity TO ${pub}, ${job}`,
			`GRANT SELECT, INSERT, UPDATE (retired_at, retention_expires_at) ON lexcerta.customers TO ${admin}`,
			`GRANT SELECT, INSERT, UPDATE ON lexcerta.api_keys TO ${admin}`,
			`GRANT SELECT, INSERT, UPDATE (public_id) ON lexcerta.api_key_admission_locks TO ${admin}`,
			`GRANT INSERT ON lexcerta.admin_audit_events TO ${admin}`,
			`GRANT EXECUTE ON FUNCTION lexcerta.remove_opinion(bigint, text, text) TO ${admin}`,
			`GRANT SELECT, DELETE ON lexcerta.api_keys, lexcerta.key_admissions, lexcerta.upstream_attempts, lexcerta.admin_audit_events TO ${job}`,
			`GRANT UPDATE (rotation_parent_id) ON lexcerta.api_keys TO ${job}`,
			`GRANT UPDATE (admitted_at) ON lexcerta.key_admissions TO ${job}`,
			`GRANT UPDATE (completed_at) ON lexcerta.upstream_attempts TO ${job}`,
			`GRANT UPDATE (public_id) ON lexcerta.admin_audit_events TO ${job}`,
			`GRANT SELECT, DELETE, UPDATE (retired_at, retention_expires_at) ON lexcerta.customers TO ${job}`,
			`GRANT SELECT, UPDATE ON lexcerta.maintenance_owner, lexcerta.maintenance_progress TO ${job}`,
			`GRANT SELECT, UPDATE (state, updated_at) ON lexcerta.citation_sources TO ${job}`,
			`GRANT SELECT, UPDATE (state, body_key, updated_at) ON lexcerta.opinion_sources TO ${job}`,
			`GRANT SELECT, DELETE, UPDATE (phase, delete_token, delete_after) ON lexcerta.source_objects TO ${job}`,
			`GRANT SELECT, INSERT, DELETE ON lexcerta.orphan_object_deletions TO ${job}`,
		];
		for (const grant of grants) await client.query(grant);
		await client.query("COMMIT");
	} catch (error) {
		await client.query("ROLLBACK").catch(() => undefined);
		throw error;
	}
}

function identifier(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

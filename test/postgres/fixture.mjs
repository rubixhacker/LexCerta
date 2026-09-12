import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { PgDatabase } from "../../build/postgres/database.js";
import { migratePostgres } from "../../build/postgres/migrations.js";

export async function createPostgresFixture() {
	const connection = process.env.LEXCERTA_TEST_DATABASE_URL;
	if (!connection)
		throw new Error(
			"LEXCERTA_TEST_DATABASE_URL must point to a disposable local PostgreSQL 18 fixture",
		);
	const base = new URL(connection);
	if (!["127.0.0.1", "localhost", "[::1]"].includes(base.hostname))
		throw new Error("PostgreSQL tests only use a loopback fixture");
	const root = new Pool({ connectionString: connection, max: 2 });
	const version = (await root.query("SHOW server_version_num")).rows[0].server_version_num;
	if (!String(version).startsWith("18")) throw new Error("PostgreSQL 18 is required");
	const suffix = randomUUID().slice(0, 8);
	const name = `lexcerta_test_${suffix}`;
	const migrationRole = `lexcerta_migrator_${suffix}`;
	const publicRole = `lexcerta_public_${suffix}`;
	const adminRole = `lexcerta_admin_${suffix}`;
	const jobRole = `lexcerta_job_${suffix}`;
	const password = "local-fixture-only";
	const roles = [migrationRole, publicRole, adminRole, jobRole];
	const pools = [];
	const closingConnections = new Set();
	try {
		for (const role of roles) await root.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
		await root.query(`CREATE DATABASE ${name} OWNER ${migrationRole}`);
		function connectionFor(role) {
			const url = new URL(base);
			url.username = role;
			url.password = password;
			url.pathname = `/${name}`;
			return url.toString();
		}
		function poolFor(role, max) {
			const pool = new Pool({
				connectionString: connectionFor(role),
				max,
				connectionTimeoutMillis: 2000,
				idleTimeoutMillis: 1000,
			});
			pools.push(pool);
			pool.on("connect", (client) => {
				const ended = new Promise((resolve) => client.once("end", resolve));
				closingConnections.add(ended);
				void ended.then(() => closingConnections.delete(ended));
			});
			return pool;
		}
		const migration = poolFor(migrationRole, 1);
		await migratePostgres(migration, "database/migrations", migrationRole);
		await migration.query(
			`GRANT USAGE ON SCHEMA lexcerta TO ${publicRole}, ${adminRole}, ${jobRole}`,
		);
		await migration.query(`GRANT SELECT ON lexcerta.api_keys TO ${publicRole}`);
		await migration.query(
			`GRANT SELECT, UPDATE ON lexcerta.api_key_admission_locks TO ${publicRole}`,
		);
		await migration.query(`GRANT SELECT, INSERT ON lexcerta.key_admissions TO ${publicRole}`);
		await migration.query(
			`GRANT SELECT, INSERT, UPDATE, DELETE ON lexcerta.upstream_budgets, lexcerta.upstream_attempts, lexcerta.citation_sources, lexcerta.opinion_sources, lexcerta.source_objects, lexcerta.orphan_object_deletions, lexcerta.cache_capacity TO ${publicRole}`,
		);
		await migration.query(
			`GRANT SELECT, INSERT, UPDATE ON lexcerta.customers, lexcerta.api_keys, lexcerta.api_key_admission_locks, lexcerta.admin_audit_events TO ${adminRole}`,
		);
		await migration.query(
			`GRANT SELECT, DELETE ON lexcerta.api_keys, lexcerta.key_admissions, lexcerta.upstream_attempts, lexcerta.admin_audit_events TO ${jobRole}`,
		);
		await migration.query(`GRANT UPDATE (rotation_parent_id) ON lexcerta.api_keys TO ${jobRole}`);
		await migration.query(`GRANT UPDATE (admitted_at) ON lexcerta.key_admissions TO ${jobRole}`);
		await migration.query(
			`GRANT UPDATE (completed_at) ON lexcerta.upstream_attempts TO ${jobRole}`,
		);
		await migration.query(`GRANT UPDATE (public_id) ON lexcerta.admin_audit_events TO ${jobRole}`);
		await migration.query(`GRANT SELECT, UPDATE, DELETE ON lexcerta.customers TO ${jobRole}`);
		const jobPool = poolFor(jobRole, 2);
		const publicPool = poolFor(publicRole, 5);
		const adminPool = poolFor(adminRole, 2);
		return {
			migration,
			migrationRole,
			publicRole,
			adminRole,
			jobPool,
			jobRole,
			jobConnection: connectionFor(jobRole),
			jobs: new PgDatabase(jobPool),
			publicPool,
			adminPool,
			publicConnection: connectionFor(publicRole),
			adminConnection: connectionFor(adminRole),
			database: new PgDatabase(publicPool),
			administration: new PgDatabase(adminPool),
			async close() {
				await Promise.all(pools.map((pool) => pool.end()));
				// pg-pool may resolve end() before the physical socket emits end.
				// Wait for those acknowledgements before dropping this fixture DB.
				await Promise.all(closingConnections);
				await root.query(`DROP DATABASE ${name} WITH (FORCE)`);
				for (const role of roles) await root.query(`DROP ROLE ${role}`);
				await root.end();
			},
		};
	} catch (error) {
		await Promise.all(pools.map((pool) => pool.end()));
		await Promise.all(closingConnections);
		await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
		for (const role of roles) await root.query(`DROP ROLE IF EXISTS ${role}`);
		await root.end();
		throw error;
	}
}

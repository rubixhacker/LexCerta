import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { PgDatabase } from "../../build/postgres/database.js";
import { migratePostgres } from "../../build/postgres/migrations.js";
import { DATABASE_CONNECTION_LIMITS } from "../../build/postgres/roles.js";
import { memoryRecoveryJournal } from "../fixtures/recovery-journal.mjs";

export async function createPostgresFixture({ initializeSchema = true } = {}) {
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
		const roleNames = {
			public: publicRole,
			admin: adminRole,
			job: jobRole,
			migrator: migrationRole,
		};
		for (const [purpose, role] of Object.entries(roleNames))
			await root.query(
				`CREATE ROLE ${role} LOGIN CONNECTION LIMIT ${DATABASE_CONNECTION_LIMITS[purpose]} PASSWORD '${password}'`,
			);
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
		if (initializeSchema)
			await migratePostgres(migration, "database/migrations", migrationRole, { roles: roleNames });
		const jobPool = poolFor(jobRole, 2);
		const publicPool = poolFor(publicRole, 5);
		const adminPool = poolFor(adminRole, 2);
		return {
			journal: memoryRecoveryJournal(),
			productionJournal: memoryRecoveryJournal("production"),
			async setRoleConnectionLimit(role, limit) {
				if (!roles.includes(role) || !Number.isInteger(limit) || limit < 1 || limit > 40)
					throw new Error("role mutation must stay inside this fixture");
				await root.query(`ALTER ROLE ${role} CONNECTION LIMIT ${limit}`);
			},
			async setRoleMembership(member, inherited, enabled) {
				if (!roles.includes(member) || !roles.includes(inherited) || member === inherited)
					throw new Error("role mutation must stay inside this fixture");
				await root.query(
					enabled ? `GRANT ${inherited} TO ${member}` : `REVOKE ${inherited} FROM ${member}`,
				);
			},
			async inspectActivity() {
				// This fixture-only root connection observes its own disposable DB.
				// Application and migration roles retain their restricted grants.
				return (
					await root.query(
						"SELECT pid, usename, application_name, state, wait_event FROM pg_stat_activity WHERE datname = $1",
						[name],
					)
				).rows;
			},
			migration,
			migrationRole,
			migrationConnection: connectionFor(migrationRole),
			roleNames,
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

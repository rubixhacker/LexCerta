import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "pg";
import { withMigrationConnection } from "./migration-connection.js";
import { applyDatabaseGrants, type DatabaseRoles, validateDatabaseRoles } from "./roles.js";

export async function migratePostgres(
	pool: Pool,
	directory: string,
	expectedRole: string,
	options: { readonly signal?: AbortSignal; readonly roles?: DatabaseRoles } = {},
): Promise<readonly string[]> {
	if (options.roles) validateDatabaseRoles(options.roles, expectedRole);
	const names = (await readdir(directory))
		.filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
		.sort();
	if (names.length === 0) throw new Error("no migrations found");
	const migrations = await Promise.all(
		names.map(async (name) => {
			const sql = await readFile(join(directory, name), "utf8");
			return { name, sql, checksum: createHash("sha256").update(sql).digest("hex") };
		}),
	);
	return withMigrationConnection(
		pool,
		expectedRole,
		async (client) => {
			await client.query(
				"CREATE TABLE IF NOT EXISTS public.lexcerta_migrations (name text PRIMARY KEY, checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'), applied_at timestamptz NOT NULL DEFAULT clock_timestamp())",
			);
			const previous = await client.query<{ name: string; checksum: string }>(
				"SELECT name, checksum FROM public.lexcerta_migrations ORDER BY name",
			);
			for (const row of previous.rows) {
				if (migrations.find((migration) => migration.name === row.name)?.checksum !== row.checksum)
					throw new Error("applied migration is missing or its checksum changed");
			}
			const latest = previous.rows.at(-1)?.name;
			if (
				latest !== undefined &&
				migrations.some(
					(migration) =>
						migration.name < latest && !previous.rows.some((row) => row.name === migration.name),
				)
			)
				throw new Error("new migration must follow the applied history");
			const applied = [];
			for (const migration of migrations) {
				if (previous.rows.some((row) => row.name === migration.name)) continue;
				try {
					await client.query("BEGIN");
					await client.query("SET LOCAL lock_timeout = '5s'");
					await client.query("SET LOCAL statement_timeout = '30s'");
					await client.query(migration.sql);
					await client.query(
						"INSERT INTO public.lexcerta_migrations(name, checksum) VALUES ($1, $2)",
						[migration.name, migration.checksum],
					);
					await client.query("COMMIT");
					applied.push(migration.name);
				} catch (error) {
					await client.query("ROLLBACK").catch(() => undefined);
					throw error;
				}
			}
			if (options.roles) await applyDatabaseGrants(client, options.roles);
			return applied;
		},
		options.signal,
	);
}

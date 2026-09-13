import { Pool, type PoolConfig } from "pg";
import type { z } from "zod";
import { PgDatabase } from "../postgres/database.js";
import { databaseRoles } from "../postgres/roles.js";
import { NeonConnection } from "./runtime-config.js";

const POOL_LIMITS = { public: 5, admin: 2, job: 2, migrator: 1 } as const;
type DatabaseRole = keyof typeof POOL_LIMITS;

export async function createNeonDatabase(
	connection: z.infer<typeof NeonConnection>,
	role: DatabaseRole,
	signal?: AbortSignal,
	createPool: (options: PoolConfig) => Pool = (options) => new Pool(options),
) {
	const parsed = NeonConnection.safeParse(connection);
	if (!parsed.success || !Object.hasOwn(POOL_LIMITS, role))
		throw new Error("Database identity configuration unavailable");
	const lifetime = new AbortController();
	const combined = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
	if (combined.aborted) throw new Error("Database initialization unavailable");
	let pool: Pool | undefined;
	let closing: Promise<void> | undefined;
	const close = () => {
		lifetime.abort();
		closing ??= pool?.end() ?? Promise.resolve();
		return closing;
	};
	try {
		const value = parsed.data;
		pool = createPool({
			host: value.host,
			port: 5432,
			database: "lexcerta",
			user: databaseRoles(value.environment)[role],
			password: value.password,
			ssl: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
			enableChannelBinding: true,
			sslnegotiation: "postgres",
			options: "-c search_path=pg_catalog",
			client_encoding: "UTF8",
			max: POOL_LIMITS[role],
			min: 0,
			connectionTimeoutMillis: 4000,
			idleTimeoutMillis: 10_000,
			maxLifetimeSeconds: 300,
			statement_timeout: 2000,
			lock_timeout: 500,
			idle_in_transaction_session_timeout: 2000,
			application_name: `lexcerta-${role}`,
		});
		const connections = pool;
		let failures = 0;
		connections.on("error", () => {
			failures += 1;
		});
		const database = new PgDatabase(connections, combined, 4000);
		// Prove authentication before serving. Console/API-created Neon owner
		// roles are not application identities, even when their names look right.
		await database.transaction(async (transaction) => {
			const result = await transaction.query<{ version: string; privileged: boolean }>(`
				SELECT current_setting('server_version_num') AS version,
				EXISTS (
					SELECT 1 FROM pg_roles r
					WHERE (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolbypassrls
						OR r.rolreplication OR r.rolname = 'neon_superuser')
					AND pg_has_role(current_user, r.oid, 'MEMBER')
				) AS privileged
			`);
			const identity = result.rows[0];
			if (!identity || !/^18\d{4}$/.test(identity.version) || identity.privileged !== false)
				throw new Error("Database identity unavailable");
		});
		return {
			database,
			get state() {
				return {
					total: connections.totalCount,
					idle: connections.idleCount,
					waiting: connections.waitingCount,
					failures,
				};
			},
			close,
		};
	} catch {
		await close().catch(() => undefined);
		throw new Error("Database initialization unavailable");
	}
}

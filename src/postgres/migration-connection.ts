import type { Pool, PoolClient } from "pg";

export class MigrationUnavailable extends Error {
	constructor() {
		super("Migration operation unavailable");
	}
}

// DDL has a separate 90-second bound from online SQL. Always destroy this
// dedicated connection, releasing its session advisory lock even after a lost
// reply. A timed-out acquisition cannot start SQL when it eventually arrives.
export async function withMigrationConnection<T>(
	pool: Pool,
	expectedRole: string,
	operation: (client: PoolClient) => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	const deadline = AbortSignal.timeout(90_000);
	const scope = signal ? AbortSignal.any([signal, deadline]) : deadline;
	let client: PoolClient | undefined;
	let finished = false;
	const cancelled = Promise.withResolvers<never>();
	const release = () => {
		const current = client;
		client = undefined;
		current?.removeListener("error", abort);
		current?.release(true);
	};
	const abort = () => {
		release();
		cancelled.reject(new MigrationUnavailable());
	};
	const attempt = async () => {
		if (scope.aborted) throw new MigrationUnavailable();
		const acquired = await pool.connect();
		if (scope.aborted || finished) {
			acquired.release(true);
			throw new MigrationUnavailable();
		}
		client = acquired;
		client.on("error", abort);
		const identity = await client.query<{ role: string }>("SELECT current_user AS role");
		if (!expectedRole || identity.rows[0]?.role !== expectedRole)
			throw new Error("migrations require a dedicated migration identity");
		const lock = await client.query<{ acquired: boolean }>(
			"SELECT pg_try_advisory_lock(746237100) AS acquired",
		);
		if (lock.rows[0]?.acquired !== true) throw new Error("another migration is running");
		return operation(client);
	};
	scope.addEventListener("abort", abort, { once: true });
	try {
		return await Promise.race([attempt(), cancelled.promise]);
	} finally {
		finished = true;
		scope.removeEventListener("abort", abort);
		release();
	}
}

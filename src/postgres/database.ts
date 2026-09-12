import type { Pool, PoolClient, QueryResultRow } from "pg";

export class PostgresUnavailableError extends Error {
	readonly name = "PostgresUnavailableError";
	constructor() {
		super("database operation unavailable");
	}
}

export class PgTransaction {
	constructor(private readonly client: PoolClient) {}
	query<Row extends QueryResultRow = QueryResultRow>(sql: string, values: readonly unknown[] = []) {
		return this.client.query<Row>(sql, [...values]);
	}
	async now(): Promise<Date> {
		const result = await this.query<{ now: Date }>("SELECT clock_timestamp() AS now");
		const now = result.rows[0]?.now;
		if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
			throw new PostgresUnavailableError();
		return now;
	}
}

export class PgDatabase {
	constructor(readonly pool: Pool) {}

	// Operations passed here contain SQL and pure state transitions only. Upstream
	// requests and object I/O run after the transaction has committed and released.
	async transaction<T>(operation: (transaction: PgTransaction) => Promise<T>): Promise<T> {
		for (let attempt = 0; ; attempt += 1) {
			const client = await this.pool.connect();
			let committing = false;
			let discard = false;
			try {
				await client.query("BEGIN");
				await client.query("SET LOCAL statement_timeout = '2s'");
				await client.query("SET LOCAL lock_timeout = '250ms'");
				await client.query("SET LOCAL idle_in_transaction_session_timeout = '5s'");
				const result = await operation(new PgTransaction(client));
				committing = true;
				await client.query("COMMIT");
				return result;
			} catch (error) {
				discard = committing;
				await client.query("ROLLBACK").catch(() => {
					discard = true;
				});
				// A lost COMMIT acknowledgement is ambiguous: never replay it.
				if (!committing && attempt < 2 && retryable(error)) continue;
				throw error;
			} finally {
				client.release(discard);
			}
		}
	}
}

function retryable(error: unknown): boolean {
	return (
		error instanceof Error && "code" in error && (error.code === "40001" || error.code === "40P01")
	);
}

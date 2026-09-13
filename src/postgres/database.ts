import type { Pool, PoolClient, QueryResultRow } from "pg";

export class PostgresUnavailableError extends Error {
	readonly name = "PostgresUnavailableError";
	constructor() {
		super("database operation unavailable");
	}
}

export class PgTransaction {
	constructor(
		private readonly client: PoolClient,
		private readonly operation: PgOperation,
	) {}
	query<Row extends QueryResultRow = QueryResultRow>(sql: string, values: readonly unknown[] = []) {
		return this.operation.wait(() => this.client.query<Row>(sql, [...values]), 2500);
	}
	async now(): Promise<Date> {
		const result = await this.query<{ now: Date }>("SELECT clock_timestamp() AS now");
		const now = result.rows[0]?.now;
		if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
			throw new PostgresUnavailableError();
		return now;
	}
}

export interface TransactionDatabase {
	transaction<T>(operation: (transaction: PgTransaction) => Promise<T>): Promise<T>;
}

export class PgDatabase implements TransactionDatabase {
	constructor(
		readonly pool: Pool,
		private readonly signal?: AbortSignal,
		private readonly acquisitionTimeoutMs = 1000,
	) {
		if (![1000, 4000].includes(acquisitionTimeoutMs))
			throw new Error("Invalid database acquisition bound");
	}

	withSignal(signal: AbortSignal): PgDatabase {
		return new PgDatabase(
			this.pool,
			this.signal === undefined ? signal : AbortSignal.any([this.signal, signal]),
			this.acquisitionTimeoutMs,
		);
	}

	// Operations passed here contain SQL and pure state transitions only. Upstream
	// requests and object I/O run after the transaction has committed and released.
	async transaction<T>(operation: (transaction: PgTransaction) => Promise<T>): Promise<T> {
		const scope = new PgOperation(this.signal, this.acquisitionTimeoutMs);
		try {
			return await scope.wait(() => this.attempt(operation, scope));
		} finally {
			scope.close();
		}
	}

	private async attempt<T>(
		operation: (transaction: PgTransaction) => Promise<T>,
		scope: PgOperation,
	): Promise<T> {
		for (let attempt = 0; ; attempt += 1) {
			const client = await scope.acquire(this.pool);
			const transaction = new PgTransaction(client, scope);
			let committing = false;
			let discard = false;
			try {
				await transaction.query("BEGIN");
				await transaction.query("SET LOCAL statement_timeout = '2s'");
				await transaction.query("SET LOCAL lock_timeout = '500ms'");
				await transaction.query("SET LOCAL idle_in_transaction_session_timeout = '2s'");
				await transaction.query("SET LOCAL transaction_timeout = '5s'");
				const result = await operation(transaction);
				scope.checkpoint();
				committing = true;
				await transaction.query("COMMIT");
				return result;
			} catch (error) {
				discard = committing;
				await transaction.query("ROLLBACK").catch(() => {
					discard = true;
				});
				// A lost COMMIT acknowledgement is ambiguous: never replay it.
				scope.checkpoint();
				if (!committing && attempt < 2 && retryable(error)) continue;
				throw error;
			} finally {
				scope.release(discard);
			}
		}
	}
}

// One short SQL operation, including retries and pool acquisition. Cancellation
// destroys the checked-out connection; PostgreSQL rolls back uncommitted work.
// This never sends a separate cancellation command that could hit a reused client.
class PgOperation {
	readonly #controller = new AbortController();
	readonly #deadline = performance.now() + 5000;
	readonly #timer = setTimeout(() => this.#cancel(), 5000);
	readonly #cancel = () => {
		this.#controller.abort();
		this.release(true);
	};
	#client: PoolClient | undefined;
	#closed = false;

	constructor(
		private readonly parent: AbortSignal | undefined,
		private readonly acquisitionTimeoutMs: number,
	) {
		if (parent?.aborted) this.#cancel();
		else parent?.addEventListener("abort", this.#cancel, { once: true });
	}

	checkpoint(): void {
		if (performance.now() >= this.#deadline) this.#cancel();
		if (this.#closed || this.#controller.signal.aborted) throw new PostgresUnavailableError();
	}

	acquire(pool: Pool): Promise<PoolClient> {
		return this.wait(async () => {
			const client = await pool.connect();
			// pg has no public API for cancelling a queued acquisition. Its own
			// configured pool timeout bounds that queue; a late client is returned
			// before any query or transaction is started on it.
			try {
				this.checkpoint();
			} catch (error) {
				client.release();
				throw error;
			}
			this.#client = client;
			client.on("error", this.#cancel);
			return client;
		}, this.acquisitionTimeoutMs);
	}

	wait<T>(operation: () => Promise<T>, timeoutMs?: number): Promise<T> {
		return new Promise((resolve, reject) => {
			const signal = this.#controller.signal;
			const abort = () => {
				clean();
				reject(new PostgresUnavailableError());
			};
			const timer = timeoutMs === undefined ? undefined : setTimeout(this.#cancel, timeoutMs);
			const clean = () => {
				clearTimeout(timer);
				signal.removeEventListener("abort", abort);
			};
			signal.addEventListener("abort", abort, { once: true });
			Promise.resolve()
				.then(() => {
					this.checkpoint();
					return operation();
				})
				.then((value) => {
					this.checkpoint();
					resolve(value);
				}, reject)
				.catch(reject)
				.finally(clean);
		});
	}

	release(discard: boolean): void {
		const client = this.#client;
		if (client === undefined) return;
		this.#client = undefined;
		client.removeListener("error", this.#cancel);
		client.release(discard);
	}

	close(): void {
		this.#closed = true;
		clearTimeout(this.#timer);
		this.parent?.removeEventListener("abort", this.#cancel);
		this.#cancel();
	}
}

function retryable(error: unknown): boolean {
	return (
		error instanceof Error && "code" in error && (error.code === "40001" || error.code === "40P01")
	);
}

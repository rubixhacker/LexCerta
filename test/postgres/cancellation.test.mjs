import assert from "node:assert/strict";
import { once } from "node:events";
import { connect, createServer } from "node:net";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { PgDatabase, PostgresUnavailableError } from "../../build/postgres/database.js";
import { poolWithCommitFault } from "./failure-fixture.mjs";
import { createPostgresFixture } from "./fixture.mjs";

let fixture;
before(async () => {
	fixture = await createPostgresFixture();
});
after(async () => {
	await fixture?.close();
});

async function until(condition, timeoutMs = 3000) {
	const deadline = performance.now() + timeoutMs;
	while (!(await condition())) {
		assert.ok(performance.now() < deadline, "database cleanup exceeded its bound");
		await delay(10);
	}
}

function singleConnectionPool() {
	return new Pool({
		connectionString: fixture.publicConnection,
		max: 1,
		connectionTimeoutMillis: 1000,
		idleTimeoutMillis: 1000,
	});
}

test("an already cancelled request never acquires a database connection", async () => {
	const pool = singleConnectionPool();
	try {
		let executed = false;
		await assert.rejects(
			new PgDatabase(pool)
				.withSignal(AbortSignal.abort("credential-sentinel"))
				.transaction(async () => {
					executed = true;
				}),
			PostgresUnavailableError,
		);
		assert.equal(executed, false);
		assert.equal(pool.totalCount, 0);
	} finally {
		await pool.end();
	}
});

test("cancelling an active statement discards its connection and rolls back its writes", async () => {
	const controller = new AbortController();
	const started = Promise.withResolvers();
	let pid;
	const pending = fixture.database
		.withSignal(controller.signal)
		.transaction(async (transaction) => {
			pid = (await transaction.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
			await transaction.query(
				"INSERT INTO lexcerta.citation_sources(citation) VALUES ('cancelled-write')",
			);
			const statement = transaction.query("SELECT pg_sleep(1.5)");
			started.resolve();
			await statement;
			assert.fail("cancelled transaction continued");
		});
	const rejected = assert.rejects(pending, PostgresUnavailableError);
	await started.promise;
	await delay(30);
	controller.abort("quote-and-credential-sentinel");
	await rejected;
	await until(async () => {
		const result = await fixture.migration.query("SELECT 1 FROM pg_stat_activity WHERE pid = $1", [
			pid,
		]);
		return result.rowCount === 0;
	});
	assert.equal(
		(
			await fixture.migration.query(
				"SELECT 1 FROM lexcerta.citation_sources WHERE citation = 'cancelled-write'",
			)
		).rowCount,
		0,
	);
	assert.equal((await fixture.database.transaction((tx) => tx.query("SELECT 1"))).rowCount, 1);
});

test("a cancelled pool waiter releases a late connection without starting SQL", async () => {
	const pool = singleConnectionPool();
	const held = await pool.connect();
	try {
		const controller = new AbortController();
		let executed = false;
		const rejected = assert.rejects(
			new PgDatabase(pool).withSignal(controller.signal).transaction(async () => {
				executed = true;
			}),
			PostgresUnavailableError,
		);
		await until(() => pool.waitingCount === 1);
		controller.abort();
		await rejected;
		held.release();
		await until(() => pool.waitingCount === 0 && pool.idleCount === 1);
		assert.equal(executed, false);
		assert.equal((await pool.query("SELECT 1")).rowCount, 1);
	} finally {
		await pool.end();
	}
});

test("an exhausted pool stops admission in one second and removes its waiter", async () => {
	const pool = singleConnectionPool();
	const held = await pool.connect();
	try {
		let executed = false;
		const start = performance.now();
		await assert.rejects(
			new PgDatabase(pool).transaction(async () => {
				executed = true;
			}),
		);
		assert.ok(performance.now() - start < 2000);
		await until(() => pool.waitingCount === 0);
		assert.equal(executed, false);
	} finally {
		held.release();
		await pool.end();
	}
});

test("cancellation during a lost COMMIT acknowledgement never replays committed work", async () => {
	const controller = new AbortController();
	let attempts = 0;
	const database = new PgDatabase(
		poolWithCommitFault(fixture.publicPool, {
			onCommit: () => controller.abort("private-sentinel"),
		}),
	).withSignal(controller.signal);
	await assert.rejects(
		database.transaction(async (transaction) => {
			attempts += 1;
			await transaction.query(
				"INSERT INTO lexcerta.citation_sources(citation) VALUES ('cancelled-commit')",
			);
		}),
		PostgresUnavailableError,
	);
	assert.equal(attempts, 1);
	assert.equal(
		(
			await fixture.migration.query(
				"SELECT 1 FROM lexcerta.citation_sources WHERE citation = 'cancelled-commit'",
			)
		).rowCount,
		1,
	);
});

test("server idle timeout aborts the operation and blocks a retained transaction from writing", async () => {
	const resume = Promise.withResolvers();
	const continuation = Promise.withResolvers();
	let transaction;
	const pending = fixture.database.transaction(async (tx) => {
		transaction = tx;
		assert.equal((await tx.query("SHOW lock_timeout")).rows[0].lock_timeout, "500ms");
		assert.equal((await tx.query("SHOW statement_timeout")).rows[0].statement_timeout, "2s");
		assert.equal(
			(await tx.query("SHOW idle_in_transaction_session_timeout")).rows[0]
				.idle_in_transaction_session_timeout,
			"2s",
		);
		assert.equal((await tx.query("SHOW transaction_timeout")).rows[0].transaction_timeout, "5s");
		await resume.promise;
		continuation.resolve();
	});
	try {
		await assert.rejects(pending, PostgresUnavailableError);
		await assert.rejects(
			transaction.query(
				"INSERT INTO lexcerta.citation_sources(citation) VALUES ('retained-transaction')",
			),
			PostgresUnavailableError,
		);
	} finally {
		resume.resolve();
		await continuation.promise;
	}
});

test("a silent database reply closes the real client socket within its read bound", async () => {
	const target = new URL(fixture.publicConnection);
	let withholdReplies = false;
	let withheldBytes = 0;
	const sockets = new Set();
	const proxy = createServer((client) => {
		const upstream = connect({ host: target.hostname, port: Number(target.port) });
		sockets.add(client);
		sockets.add(upstream);
		client.pipe(upstream);
		upstream.on("data", (chunk) => {
			if (!withholdReplies) client.write(chunk);
			else withheldBytes += chunk.byteLength;
		});
		client.on("error", () => upstream.destroy());
		upstream.on("error", () => client.destroy());
		client.on("close", () => {
			sockets.delete(client);
			upstream.destroy();
		});
		upstream.on("close", () => sockets.delete(upstream));
	});
	proxy.listen(0, "127.0.0.1");
	await once(proxy, "listening");
	const proxied = new URL(target);
	proxied.port = String(proxy.address().port);
	const pool = new Pool({
		connectionString: proxied.toString(),
		max: 1,
		connectionTimeoutMillis: 1000,
	});
	try {
		const start = performance.now();
		await assert.rejects(
			new PgDatabase(pool).transaction(async (transaction) => {
				withholdReplies = true;
				await transaction.query("SELECT 1");
			}),
			PostgresUnavailableError,
		);
		assert.ok(performance.now() - start < 4000);
		assert.equal(withholdReplies, true);
		assert.ok(withheldBytes > 0);
		await until(() => sockets.size === 0);
		assert.equal(pool.totalCount, 0);
	} finally {
		await pool.end();
		for (const socket of sockets) socket.destroy();
		await new Promise((resolve) => proxy.close(resolve));
	}
});

test("short statements cannot extend one authority transaction beyond five seconds", async () => {
	let completed = 0;
	const start = performance.now();
	await assert.rejects(
		fixture.database.transaction(async (transaction) => {
			for (let index = 0; index < 8; index += 1) {
				await transaction.query("SELECT pg_sleep(0.7)");
				completed += 1;
			}
		}),
		PostgresUnavailableError,
	);
	assert.ok(completed < 8);
	assert.ok(performance.now() - start < 6500);
});

import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { PgDatabase } from "../../build/postgres/database.js";
import { runPublicProcess } from "../../build/node/public-main.js";
import { readPublicConfig } from "../../build/node/runtime-config.js";
import { withObjects } from "../fixtures/gcs-wire-fixture.mjs";

const connection = new URL(process.env.LEXCERTA_TEST_DATABASE_URL);
assert.equal(connection.hostname, "host.docker.internal");
assert.match(connection.pathname, /^\/lexcerta_test_[a-f0-9]+$/);
const stopped = Promise.withResolvers();
const failures = [];
const source = createServer((request, response) => {
	void (async () => {
		assert.equal(request.headers.authorization, "Token synthetic-upstream-token");
		const url = new URL(request.url, "http://fixture");
		let value;
		if (url.pathname.endsWith("citation-lookup/")) {
			value = [
				{
					status: 200,
					normalized_citations: ["410 U.S. 113"],
					clusters: [{ id: 123, absolute_url: "/opinion/123/fixture/" }],
				},
			];
		} else if (url.pathname.endsWith("clusters/123/")) {
			value = {
				id: 123,
				absolute_url: "/opinion/123/fixture/",
				sub_opinions: ["https://www.courtlistener.com/api/rest/v4/opinions/456/"],
			};
		} else if (url.pathname.endsWith("opinions/456/")) {
			process.stdout.write("fixture_opinion_started\n");
			await delay(2000);
			value = {
				id: 456,
				cluster: "https://www.courtlistener.com/api/rest/v4/clusters/123/",
				plain_text: "Public container source sentinel.",
			};
		} else throw new Error("unexpected fixture source request");
		if (response.destroyed) return;
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify(value));
	})().catch((error) => {
		failures.push(error);
		response.destroy();
	});
});
source.listen(0, "127.0.0.1");
await once(source, "listening");
try {
	await withObjects(async ({ objects, requests }) => {
		await runPublicProcess(async () => {
			const pool = new Pool({
				connectionString: connection.toString(),
				max: 5,
				connectionTimeoutMillis: 1000,
				idleTimeoutMillis: 10_000,
				statement_timeout: 2000,
				lock_timeout: 500,
				idle_in_transaction_session_timeout: 2000,
				application_name: "lexcerta-container-public",
			});
			pool.on("error", () => {
				failures.push(new Error("fixture pool failure"));
			});
			return {
				config: readPublicConfig(process.env),
				storage: {
					database: new PgDatabase(pool),
					async close() {
						await pool.end();
						process.stdout.write(
							`${JSON.stringify({
								fixture_closed: true,
								object_requests: requests.length,
								failures: failures.length,
								max_rss_kib: process.resourceUsage().maxRSS,
							})}\n`,
						);
						stopped.resolve();
					},
				},
				objects: (signal) => objects.withSignal(signal),
				transport: (request) => {
					const url = new URL(request.url);
					assert.equal(url.origin, "https://www.courtlistener.com");
					return fetch(`http://127.0.0.1:${source.address().port}${url.pathname}${url.search}`, {
						method: request.method,
						headers: request.headers,
						body: request.body,
						signal: request.signal,
						duplex: "half",
						redirect: "manual",
					});
				},
			};
		});
		await stopped.promise;
	});
} finally {
	source.closeAllConnections();
	await new Promise((resolve) => source.close(resolve));
}
assert.equal(failures.length, 0);

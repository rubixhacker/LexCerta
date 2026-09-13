import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { Pool } from "pg";
import { runOperatorProcess } from "../../build/node/operator-main.js";
import { memoryRecoveryJournal } from "../fixtures/recovery-journal.mjs";
import { createOperatorIdentityVerifier } from "../../build/node/operator-identity.js";
import { readOperatorConfig } from "../../build/node/runtime-config.js";
import { PgDatabase } from "../../build/postgres/database.js";

const connection = new URL(process.env.LEXCERTA_TEST_DATABASE_URL);
assert.equal(connection.hostname, "host.docker.internal");
assert.match(connection.pathname, /^\/lexcerta_test_[a-f0-9]+$/);
const certificates = await readFile(new URL("./certificates.json", import.meta.url));
let certificateCalls = 0;
const certServer = createServer((_request, response) => {
	certificateCalls += 1;
	response.writeHead(200, { "content-type": "application/json", "cache-control": "max-age=3600" });
	response.end(certificates);
});
certServer.listen(0, "127.0.0.1");
await once(certServer, "listening");
const stopped = Promise.withResolvers();
let failures = 0;
try {
	await runOperatorProcess(async () => {
		const config = readOperatorConfig(process.env);
		const pool = new Pool({
			connectionString: connection.toString(),
			max: 2,
			connectionTimeoutMillis: 1000,
			idleTimeoutMillis: 10_000,
			statement_timeout: 2000,
			lock_timeout: 500,
			idle_in_transaction_session_timeout: 2000,
			application_name: "lexcerta-container-operator",
		});
		pool.on("error", () => {
			failures += 1;
		});
		return {
			config,
			journal: memoryRecoveryJournal(config.environment),
			identity: createOperatorIdentityVerifier(config.audience, config.subjects, (url, options) => {
				assert.equal(url, "https://www.googleapis.com/oauth2/v1/certs");
				return fetch(`http://127.0.0.1:${certServer.address().port}`, options);
			}),
			storage: {
				database: new PgDatabase(pool),
				async close() {
					await pool.end();
					process.stdout.write(
						`${JSON.stringify({ fixture_closed: true, failures, certificate_calls: certificateCalls, max_rss_kib: process.resourceUsage().maxRSS })}\n`,
					);
					stopped.resolve();
				},
			},
		};
	});
	await stopped.promise;
} finally {
	certServer.closeAllConnections();
	await new Promise((resolve) => certServer.close(resolve));
}
assert.equal(failures, 0);

import { setTimeout as delay } from "node:timers/promises";
import { runPublicProcess } from "../../build/node/public-main.js";
import { readPublicConfig } from "../../build/node/runtime-config.js";
import { PgDatabase } from "../../build/postgres/database.js";

await runPublicProcess(async (signal) => {
	const mode = process.argv[2];
	if (mode === "failure") throw new Error("private-startup-credential-sentinel");
	if (mode === "unhandled")
		setImmediate(() => {
			void Promise.reject(new Error("private-promise-sentinel"));
		});
	if (mode === "uncaught")
		setImmediate(() => {
			throw new Error("private-exception-sentinel");
		});
	if (["startup-abort", "late-startup"].includes(mode)) {
		const pendingWork = setTimeout(() => {}, 60_000);
		process.stdout.write("initializing\n");
		await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
		clearTimeout(pendingWork);
		process.stdout.write("initialization-cancelled\n");
		if (mode === "startup-abort") throw new Error("private-cancel-credential-sentinel");
		await delay(50);
	}
	return {
		config: readPublicConfig({
			LEXCERTA_ENVIRONMENT: "staging",
			GOOGLE_CLOUD_PROJECT: "fixture-project",
			LEXCERTA_DATABASE_HOST: "ep-fixture-123.us-east-2.aws.neon.tech",
			LEXCERTA_DATABASE_PASSWORD: "synthetic-neon-fixture-password-32",
			LEXCERTA_BUILD_ID: "0".repeat(40),
			API_KEY_PEPPER: "synthetic-process-fixture-pepper-value",
			COURTLISTENER_CREDENTIAL_ID: "fixture",
			COURTLISTENER_API_TOKEN: "synthetic-fixture-token",
			PORT: process.env.PORT,
		}),
		storage: {
			database: new PgDatabase({
				connect: async () => {
					throw new Error("unexpected SQL");
				},
			}),
			close: async () => {
				process.stdout.write("storage-closed\n");
			},
		},
		objects: () => {
			throw new Error("unexpected source request");
		},
	};
});

import type { PgDatabase } from "../postgres/database.js";
import type { RecoveryJournalWriter } from "../postgres/recovery-journal.js";
import { createGcsRecoveryJournal } from "./gcs-recovery-journal.js";
import { createNeonDatabase } from "./neon-database.js";
import { createOperatorRequestHandler } from "./operator-application.js";
import { createOperatorHttpServer } from "./operator-http.js";
import { createOperatorIdentityVerifier, type OperatorIdentity } from "./operator-identity.js";
import { readOperatorConfig } from "./runtime-config.js";
import { runServiceProcess } from "./service-process.js";

type OperatorResources = {
	readonly config: ReturnType<typeof readOperatorConfig>;
	readonly storage: { readonly database: PgDatabase; close(): Promise<void> };
	readonly identity: OperatorIdentity;
	readonly journal: RecoveryJournalWriter;
};

async function initializeCloudResources(signal: AbortSignal): Promise<OperatorResources> {
	const config = readOperatorConfig(process.env);
	const identity = createOperatorIdentityVerifier(config.audience, config.subjects);
	const journal = createGcsRecoveryJournal(
		`${config.project}-lexcerta-recovery`,
		config.environment,
	);
	const storage = await createNeonDatabase(config.database, "admin", signal);
	return { config, identity, storage, journal };
}

export async function runOperatorProcess(
	initialize: (signal: AbortSignal) => Promise<OperatorResources> = initializeCloudResources,
) {
	await runServiceProcess(async (signal) => {
		const resources = await initialize(signal);
		return {
			port: resources.config.port,
			start: () =>
				createOperatorHttpServer(
					createOperatorRequestHandler({
						database: resources.storage.database,
						journal: resources.journal,
						identity: resources.identity,
						environment: resources.config.keyEnvironment,
						pepper: resources.config.pepper,
						customers: resources.config.customers,
					}),
					{ build: resources.config.build },
				),
			close: () => resources.storage.close(),
		};
	});
}

if (import.meta.main) void runOperatorProcess();

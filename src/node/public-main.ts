import type { CourtListenerTransport } from "../courtlistener/api.js";
import type { PgDatabase } from "../postgres/database.js";
import type { SourceObjects } from "../postgres/objects.js";
import { createNeonDatabase } from "./neon-database.js";
import { createGcsSourceObjects } from "./gcs-source-objects.js";
import { NodeOpinionNormalizer } from "./opinion-normalizer.js";
import { createPublicRequestHandler } from "./public-application.js";
import { createPublicHttpServer } from "./public-http.js";
import { runServiceProcess } from "./service-process.js";
import { readPublicConfig } from "./runtime-config.js";

type PublicResources = {
	readonly config: ReturnType<typeof readPublicConfig>;
	readonly storage: { readonly database: PgDatabase; close(): Promise<void> };
	readonly objects: (signal: AbortSignal) => SourceObjects;
	readonly transport?: CourtListenerTransport;
};

async function initializeCloudResources(signal: AbortSignal): Promise<PublicResources> {
	const config = readPublicConfig(process.env);
	const objects = createGcsSourceObjects(config.sourceBucket);
	const storage = await createNeonDatabase(config.database, "public", signal);
	return { config, storage, objects: (requestSignal) => objects.withSignal(requestSignal) };
}

// The container fixture injects local resources into this same process lifecycle.
// The executable entry uses configured Neon credentials and attached GCS identity.
export async function runPublicProcess(
	initialize: (signal: AbortSignal) => Promise<PublicResources> = initializeCloudResources,
) {
	await runServiceProcess(async (signal) => {
		const resources = await initialize(signal);
		let normalizer: NodeOpinionNormalizer | undefined;
		return {
			port: resources.config.port,
			start() {
				const config = resources.config;
				normalizer = new NodeOpinionNormalizer();
				return createPublicHttpServer(
					createPublicRequestHandler({
						database: resources.storage.database,
						objects: resources.objects,
						normalize: normalizer.normalize,
						environment: config.keyEnvironment,
						pepper: config.pepper,
						credentialId: config.credentialId,
						upstreamToken: config.upstreamToken,
						...(resources.transport ? { transport: resources.transport } : {}),
					}),
					{ build: config.build },
				);
			},
			async close() {
				await Promise.all([normalizer?.close(), resources.storage.close()]);
			},
		};
	});
}

if (import.meta.main) void runPublicProcess();

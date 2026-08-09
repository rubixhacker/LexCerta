import { createD1R2OpinionSourceStore } from "../cache/d1-r2-opinion-source-store.js";
import { createCourtListenerApi } from "../courtlistener/api.js";
import { createCourtListenerCaseLawApi } from "../courtlistener/case-law-api.js";
import { createCourtListenerCaseLawGateway } from "../courtlistener/case-law-gateway.js";
import type { CourtListenerCoordinatorRpc } from "../courtlistener/coordinator.js";
import type { QuoteVerificationGateway } from "./verify-quote.js";

type CoordinatorNamespace = {
	readonly getByName: (name: string) => CourtListenerCoordinatorRpc;
};

type WorkerQuoteGatewayInput = {
	readonly coordinator: CoordinatorNamespace | undefined;
	readonly credentialId: string | undefined;
	readonly database: D1Database;
	readonly opinionCache: R2Bucket | undefined;
	readonly token: string | undefined;
};

export function createWorkerQuoteGateway(input: WorkerQuoteGatewayInput): QuoteVerificationGateway {
	if (
		input.token === undefined ||
		input.token.trim().length === 0 ||
		input.credentialId === undefined ||
		input.credentialId.length === 0 ||
		input.coordinator === undefined ||
		input.opinionCache === undefined
	) {
		return unavailableQuoteGateway();
	}
	try {
		return createCourtListenerCaseLawGateway({
			api: createCourtListenerCaseLawApi({
				token: input.token,
				transport: (request) => fetch(request),
			}),
			coordinator: input.coordinator.getByName(input.credentialId),
			now: () => new Date(),
			opinions: createD1R2OpinionSourceStore({
				bucket: input.opinionCache,
				database: input.database,
			}),
			quotaApi: createCourtListenerApi({
				token: input.token,
				transport: (request) => fetch(request),
			}),
			token: () => crypto.randomUUID(),
		});
	} catch {
		// no-excuse-ok: catch
		return unavailableQuoteGateway();
	}
}

function unavailableQuoteGateway(): QuoteVerificationGateway {
	return {
		readCluster: async () => ({ kind: "indeterminate", reason: "upstream_unavailable" }),
		readOpinion: async () => ({ kind: "indeterminate", reason: "upstream_unavailable" }),
	};
}

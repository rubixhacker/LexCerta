import { createD1CitationObservationStore } from "../cache/d1-citation-observation-store.js";
import { createCourtListenerApi } from "../courtlistener/api.js";
import type { CourtListenerCoordinatorRpc } from "../courtlistener/coordinator.js";
import { createCourtListenerCitationGateway } from "../courtlistener/gateway.js";
import {
	type ExecutionFactObserver,
	createCourtListenerAttemptTiming,
} from "../telemetry/execution-facts.js";
import { createCachedCitationGateway } from "./cached-citation-gateway.js";
import type { CitationVerificationGateway } from "./verify-citation.js";

type CoordinatorNamespace = {
	readonly getByName: (name: string) => CourtListenerCoordinatorRpc;
};

type WorkerCitationGatewayInput = {
	readonly coordinator: CoordinatorNamespace | undefined;
	readonly credentialId: string | undefined;
	readonly database: D1Database;
	readonly executionFacts?: ExecutionFactObserver;
	readonly token: string | undefined;
};

export function createWorkerCitationGateway(
	input: WorkerCitationGatewayInput,
): CitationVerificationGateway {
	return createCachedCitationGateway({
		...(input.executionFacts === undefined ? {} : { executionFacts: input.executionFacts }),
		now: () => new Date(),
		ownerToken: () => crypto.randomUUID(),
		store: createD1CitationObservationStore(input.database),
		upstream: createUpstreamCitationGateway(input),
	});
}

function createUpstreamCitationGateway(
	input: WorkerCitationGatewayInput,
): CitationVerificationGateway {
	if (
		input.token === undefined ||
		input.token.trim().length === 0 ||
		input.credentialId === undefined ||
		input.credentialId.length === 0 ||
		input.coordinator === undefined
	) {
		return unavailableCitationGateway(input.executionFacts);
	}
	const attemptTiming = createCourtListenerAttemptTiming(input.executionFacts);
	try {
		return createCourtListenerCitationGateway({
			...(input.executionFacts === undefined ? {} : { executionFacts: input.executionFacts }),
			api: createCourtListenerApi({
				...(attemptTiming === undefined ? {} : { attemptTiming }),
				token: input.token,
				transport: (request) => fetch(request),
			}),
			coordinator: input.coordinator.getByName(input.credentialId),
			now: () => new Date(),
			token: () => crypto.randomUUID(),
		});
	} catch {
		// no-excuse-ok: catch
		return unavailableCitationGateway(input.executionFacts);
	}
}

function unavailableCitationGateway(
	executionFacts: ExecutionFactObserver | undefined,
): CitationVerificationGateway {
	return {
		lookup: async () => {
			executionFacts?.observe({ kind: "upstream", status: "unavailable" });
			return { kind: "indeterminate", reason: "upstream_unavailable" };
		},
	};
}

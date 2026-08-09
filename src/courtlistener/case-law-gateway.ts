import type { OpinionSourceStore } from "../cache/opinion-source-store.js";
import type { QuoteVerificationGateway } from "../verification/verify-quote.js";
import type { CourtListenerApi } from "./api.js";
import { requestCaseLaw } from "./case-law-admission.js";
import type { CourtListenerCaseLawApi } from "./case-law-api.js";
import { readCachedCaseLawOpinion } from "./case-law-opinion-source.js";
import type { CourtListenerCoordinatorRpc } from "./coordinator.js";

type QuoteFailureReason =
	| "incomplete"
	| "timeout"
	| "upstream_unavailable"
	| "quota_unknown"
	| "rate_limited"
	| "circuit_open";

export type CourtListenerCaseLawGatewayOptions = {
	readonly api: CourtListenerCaseLawApi;
	readonly coordinator: CourtListenerCoordinatorRpc;
	readonly now: () => Date;
	readonly opinions: OpinionSourceStore;
	readonly quotaApi: Pick<CourtListenerApi, "getUsage">;
	readonly token: () => string;
};

export function createCourtListenerCaseLawGateway(
	options: CourtListenerCaseLawGatewayOptions,
): QuoteVerificationGateway {
	return {
		async readCluster(expected) {
			const requested = await requestCaseLaw(options, () => options.api.getCluster(expected.id));
			if (requested.kind === "indeterminate") return requested;
			const source = requested.source;
			switch (source.kind) {
				case "found":
					return source.cluster.id === expected.id &&
						source.cluster.canonicalUrl === expected.canonicalUrl
						? {
								kind: "found",
								cluster: {
									canonicalUrl: source.cluster.canonicalUrl,
									id: source.cluster.id,
									opinionUrls: source.cluster.subOpinions.map((opinion) => opinion.url),
								},
							}
						: indeterminate("incomplete");
				case "missing":
				case "malformed_response":
					return indeterminate("incomplete");
				case "rate_limited":
					return indeterminate("rate_limited", source.retryAfterSeconds);
				case "unavailable":
					return indeterminate(source.failure === "timeout" ? "timeout" : "upstream_unavailable");
				default:
					return assertNever(source);
			}
		},
		readOpinion: (input) =>
			readCachedCaseLawOpinion(input, {
				fetch: async (opinionUrl) => {
					const requested = await requestCaseLaw(options, () => options.api.getOpinion(opinionUrl));
					return requested.kind === "source" ? requested.source : requested;
				},
				now: options.now,
				store: options.opinions,
				token: options.token,
			}),
	};
}

function indeterminate(reason: QuoteFailureReason, retryAfterSeconds?: number) {
	return {
		kind: "indeterminate" as const,
		reason,
		...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
	};
}

function assertNever(value: never): never {
	throw new TypeError(`Unexpected CourtListener case-law outcome: ${String(value)}`);
}

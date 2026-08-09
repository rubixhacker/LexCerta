import type { QuoteVerificationGateway } from "../verification/verify-quote.js";
import type { CourtListenerApi } from "./api.js";
import { requestCaseLaw } from "./case-law-admission.js";
import type {
	CourtListenerCaseLawApi,
	CourtListenerCaseLawOutcome,
	CourtListenerCaseLawOpinion,
} from "./case-law-api.js";
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
		async readOpinion(input) {
			const requested = await requestCaseLaw(options, () =>
				options.api.getOpinion(input.opinionUrl),
			);
			if (requested.kind === "indeterminate") return requested;
			return opinionObservation(
				requested.source,
				input.cluster.id,
				input.cluster.canonicalUrl,
				options.now(),
			);
		},
	};
}

function opinionObservation(
	source: CourtListenerCaseLawOutcome<{ readonly opinion: CourtListenerCaseLawOpinion }>,
	clusterId: number,
	canonicalUrl: string,
	retrievedAt: Date,
) {
	switch (source.kind) {
		case "found":
			return source.opinion.clusterId === clusterId
				? {
						kind: "found" as const,
						opinion: {
							canonicalUrl,
							clusterId,
							freshness: "fresh" as const,
							id: source.opinion.id,
							retrievedAt: retrievedAt.toISOString(),
							text: {
								...(source.opinion.html === undefined ? {} : { html: source.opinion.html }),
								...(source.opinion.htmlWithCitations === undefined
									? {}
									: { html_with_citations: source.opinion.htmlWithCitations }),
								...(source.opinion.plainText === undefined
									? {}
									: { plain_text: source.opinion.plainText }),
							},
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

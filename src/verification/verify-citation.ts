import { z } from "zod";
import { CONTRACT_VERSION, parseCitation } from "./citation.js";

export { CONTRACT_VERSION } from "./citation.js";

const citationInputSchema = z
	.string()
	.min(1)
	.max(256)
	.describe("Supported case-law citation in volume reporter page form.");

export const verifyCitationInputSchema = z.object({ citation: citationInputSchema }).strict();

const evidenceSchema = z
	.object({
		source: z.literal("courtlistener"),
		normalizedCitation: z.string().min(1),
		retrievedAt: z.iso.datetime(),
		freshness: z.enum(["fresh", "stale"]),
	})
	.strict();

const courtListenerPublicUrlSchema = z.url().refine((value) => {
	const url = new URL(value);
	return (
		url.protocol === "https:" &&
		(url.hostname === "courtlistener.com" || url.hostname === "www.courtlistener.com")
	);
}, "Expected an HTTPS CourtListener public URL.");

const verifiedCitationResultSchema = z
	.object({
		outcome: z.literal("verified"),
		contractVersion: z.literal(CONTRACT_VERSION),
		evidence: evidenceSchema.extend({
			cluster: z
				.object({
					id: z.number().int().positive(),
					canonicalUrl: courtListenerPublicUrlSchema,
				})
				.strict(),
		}),
	})
	.strict();

const notFoundCitationResultSchema = z
	.object({
		outcome: z.literal("not_found"),
		contractVersion: z.literal(CONTRACT_VERSION),
		evidence: evidenceSchema.extend({ searchComplete: z.literal(true) }),
	})
	.strict();

const retryLaterSchema = z.object({ action: z.literal("retry_later") }).strict();

const unsupportedCitationResultSchema = z
	.object({
		outcome: z.literal("indeterminate"),
		contractVersion: z.literal(CONTRACT_VERSION),
		reason: z.literal("unsupported_citation"),
		retry: z.object({ action: z.literal("use_supported_citation") }).strict(),
	})
	.strict();

const retryableCitationResultSchema = z
	.object({
		outcome: z.literal("indeterminate"),
		contractVersion: z.literal(CONTRACT_VERSION),
		reason: z.enum([
			"incomplete",
			"timeout",
			"upstream_unavailable",
			"quota_unknown",
			"source_changed",
		]),
		retry: retryLaterSchema,
	})
	.strict();

const delayedRetryCitationResultSchema = z
	.object({
		outcome: z.literal("indeterminate"),
		contractVersion: z.literal(CONTRACT_VERSION),
		reason: z.enum(["rate_limited", "circuit_open"]),
		retry: retryLaterSchema.extend({ retryAfterSeconds: z.number().int().positive().optional() }),
	})
	.strict();

export const verifyCitationOutputSchema = z.union([
	verifiedCitationResultSchema,
	notFoundCitationResultSchema,
	unsupportedCitationResultSchema,
	retryableCitationResultSchema,
	delayedRetryCitationResultSchema,
]);

export type VerifyCitationInput = {
	readonly citation: string;
};

export type CitationLookup = {
	readonly volume: number;
	readonly reporter: string;
	readonly page: number;
	readonly normalizedCitation: string;
};

export type CourtListenerCluster = {
	readonly id: number;
	readonly canonicalUrl: string;
};

type RetryableCitationReason =
	| "incomplete"
	| "timeout"
	| "upstream_unavailable"
	| "quota_unknown"
	| "source_changed";

export type CitationVerificationObservation =
	| {
			readonly kind: "verified";
			readonly cluster: CourtListenerCluster;
			readonly freshness: "fresh" | "stale";
			readonly retrievedAt: string;
	  }
	| { readonly kind: "not_found"; readonly retrievedAt: string }
	| {
			readonly kind: "indeterminate";
			readonly reason: RetryableCitationReason;
	  }
	| {
			readonly kind: "indeterminate";
			readonly reason: "rate_limited" | "circuit_open";
			readonly retryAfterSeconds?: number;
	  };

export interface CitationVerificationGateway {
	lookup(query: CitationLookup): Promise<CitationVerificationObservation>;
}

type EvidenceProvenance = {
	readonly source: "courtlistener";
	readonly normalizedCitation: string;
	readonly retrievedAt: string;
	readonly freshness: "fresh" | "stale";
};

export type VerifyCitationResult =
	| {
			readonly outcome: "verified";
			readonly contractVersion: typeof CONTRACT_VERSION;
			readonly evidence: EvidenceProvenance & { readonly cluster: CourtListenerCluster };
	  }
	| {
			readonly outcome: "not_found";
			readonly contractVersion: typeof CONTRACT_VERSION;
			readonly evidence: EvidenceProvenance & { readonly searchComplete: true };
	  }
	| {
			readonly outcome: "indeterminate";
			readonly contractVersion: typeof CONTRACT_VERSION;
			readonly reason: "unsupported_citation";
			readonly retry: { readonly action: "use_supported_citation" };
	  }
	| {
			readonly outcome: "indeterminate";
			readonly contractVersion: typeof CONTRACT_VERSION;
			readonly reason: RetryableCitationReason;
			readonly retry: { readonly action: "retry_later" };
	  }
	| {
			readonly outcome: "indeterminate";
			readonly contractVersion: typeof CONTRACT_VERSION;
			readonly reason: "rate_limited" | "circuit_open";
			readonly retry: { readonly action: "retry_later"; readonly retryAfterSeconds?: number };
	  };

export const verifyCitationToolDefinition = {
	title: "Verify citation",
	description: "Verify a supported case-law citation against CourtListener evidence.",
	inputSchema: verifyCitationInputSchema,
	outputSchema: verifyCitationOutputSchema,
	annotations: {
		title: "Verify citation",
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
} as const;

function evidenceProvenance(
	normalizedCitation: string,
	retrievedAt: string,
	freshness: EvidenceProvenance["freshness"],
): EvidenceProvenance {
	return { source: "courtlistener", normalizedCitation, retrievedAt, freshness };
}

export async function verifyCitation(
	input: VerifyCitationInput,
	gateway: CitationVerificationGateway,
): Promise<VerifyCitationResult> {
	const parsed = parseCitation(input.citation);
	if (parsed.outcome === "unrecognized") {
		return {
			outcome: "indeterminate",
			contractVersion: CONTRACT_VERSION,
			reason: "unsupported_citation",
			retry: { action: "use_supported_citation" },
		};
	}

	const observation = await gateway.lookup({
		volume: parsed.citation.volume,
		reporter: parsed.citation.reporter,
		page: parsed.citation.page,
		normalizedCitation: parsed.citation.normalized,
	});

	switch (observation.kind) {
		case "verified":
			return {
				outcome: "verified",
				contractVersion: CONTRACT_VERSION,
				evidence: {
					...evidenceProvenance(
						parsed.citation.normalized,
						observation.retrievedAt,
						observation.freshness,
					),
					cluster: observation.cluster,
				},
			};
		case "not_found":
			return {
				outcome: "not_found",
				contractVersion: CONTRACT_VERSION,
				evidence: {
					...evidenceProvenance(parsed.citation.normalized, observation.retrievedAt, "fresh"),
					searchComplete: true,
				},
			};
		case "indeterminate":
			switch (observation.reason) {
				case "rate_limited":
				case "circuit_open":
					return {
						outcome: "indeterminate",
						contractVersion: CONTRACT_VERSION,
						reason: observation.reason,
						retry: {
							action: "retry_later",
							...(observation.retryAfterSeconds === undefined
								? {}
								: { retryAfterSeconds: observation.retryAfterSeconds }),
						},
					};
				case "incomplete":
				case "timeout":
				case "upstream_unavailable":
				case "quota_unknown":
				case "source_changed":
					return {
						outcome: "indeterminate",
						contractVersion: CONTRACT_VERSION,
						reason: observation.reason,
						retry: { action: "retry_later" },
					};
			}
	}
}

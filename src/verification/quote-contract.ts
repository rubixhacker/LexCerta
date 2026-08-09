import { z } from "zod";
import { CONTRACT_VERSION } from "./citation.js";

export const OPINION_TEXT_REPRESENTATIONS = ["html_with_citations", "html", "plain_text"] as const;

export type OpinionTextRepresentation = (typeof OPINION_TEXT_REPRESENTATIONS)[number];

export type OpinionTextSource = {
	readonly html_with_citations?: string;
	readonly html?: string;
	readonly plain_text?: string;
};

export type SelectedOpinionText = {
	readonly representation: OpinionTextRepresentation;
	readonly content: string;
};

const courtListenerUrlSchema = z.url().refine((value) => {
	const url = new URL(value);
	return (
		url.protocol === "https:" &&
		(url.hostname === "courtlistener.com" || url.hostname === "www.courtlistener.com")
	);
}, "Expected an HTTPS CourtListener URL.");

const retryLaterSchema = z
	.object({
		action: z.literal("retry_later"),
		retryAfterSeconds: z.number().int().positive().optional(),
	})
	.strict();
const supportedCitationRetrySchema = z
	.object({ action: z.literal("use_supported_citation") })
	.strict();

function boundedUnicodeString(minimum: number, maximum: number) {
	return z
		.string()
		.min(minimum)
		.max(maximum)
		.refine((value) => {
			const length = Array.from(value).length;
			return length >= minimum && length <= maximum;
		}, `Expected ${minimum} to ${maximum} Unicode code points.`);
}

export const verifyQuoteInputSchema = z
	.object({ citation: boundedUnicodeString(1, 256), quote: boundedUnicodeString(20, 10_000) })
	.strict();

const searchedOpinionSchema = z
	.object({
		id: z.number().int().positive(),
		canonicalUrl: courtListenerUrlSchema,
		representation: z.enum(OPINION_TEXT_REPRESENTATIONS),
		retrievedAt: z.iso.datetime(),
		freshness: z.enum(["fresh", "stale"]),
	})
	.strict();

const evidenceSchema = z
	.object({
		source: z.literal("courtlistener"),
		normalizedCitation: z.string().min(1),
		citationRetrievedAt: z.iso.datetime(),
		citationFreshness: z.enum(["fresh", "stale"]),
		cluster: z
			.object({ id: z.number().int().positive(), canonicalUrl: courtListenerUrlSchema })
			.strict()
			.nullable(),
		searchedOpinionCount: z.number().int().nonnegative(),
		requiredOpinionCount: z.number().int().nonnegative(),
		searchComplete: z.boolean(),
		searchedOpinions: z.array(searchedOpinionSchema),
	})
	.strict();

const indeterminateSchema = z
	.object({
		outcome: z.literal("indeterminate"),
		contractVersion: z.literal(CONTRACT_VERSION),
		reason: z.enum([
			"unsupported_citation",
			"incomplete",
			"source_text_unavailable",
			"cluster_limit_exceeded",
			"timeout",
			"upstream_unavailable",
			"quota_unknown",
			"source_changed",
			"rate_limited",
			"circuit_open",
		]),
		retry: z.union([retryLaterSchema, supportedCitationRetrySchema]),
	})
	.strict()
	.superRefine((result, context) => {
		const shouldUseSupportedCitation = result.reason === "unsupported_citation";
		if (shouldUseSupportedCitation === (result.retry.action === "use_supported_citation")) return;
		context.addIssue({
			code: "custom",
			message: "Retry action must match the indeterminate reason.",
		});
	});

export const verifyQuoteOutputSchema = z.discriminatedUnion("outcome", [
	z
		.object({
			outcome: z.literal("verified"),
			contractVersion: z.literal(CONTRACT_VERSION),
			evidence: evidenceSchema.extend({
				matchingOpinion: z
					.object({ id: z.number().int().positive(), canonicalUrl: courtListenerUrlSchema })
					.strict(),
				representation: z.enum(OPINION_TEXT_REPRESENTATIONS),
				retrievedAt: z.iso.datetime(),
				freshness: z.enum(["fresh", "stale"]),
			}),
		})
		.strict(),
	z
		.object({
			outcome: z.literal("not_found"),
			contractVersion: z.literal(CONTRACT_VERSION),
			evidence: evidenceSchema,
		})
		.strict(),
	indeterminateSchema,
]);

export type VerifyQuoteInput = z.infer<typeof verifyQuoteInputSchema>;
export type VerifyQuoteResult = z.infer<typeof verifyQuoteOutputSchema>;
export type QuoteIndeterminateReason = Extract<
	VerifyQuoteResult,
	{ readonly outcome: "indeterminate" }
>["reason"];

export {
	canonicalOpinionText,
	normalizeQuoteText,
	selectOpinionText,
} from "./quote-normalization.js";

import { z } from "zod";
import type {
	OpinionSourceCacheState,
	OpinionSourceProvenance,
	PositiveOpinionSourceObservation,
} from "../verification/opinion-source-cache.js";

const provenanceSchema = z
	.object({
		canonicalUrl: z.string().url().max(2_048).refine(isCourtListenerUrl),
		clusterId: z.number().int().positive(),
		opinionId: z.number().int().positive(),
	})
	.strict();
const representationSchema = z.enum(["html_with_citations", "html", "plain_text"]);
const positiveSchema = z
	.object({
		kind: z.literal("positive"),
		provenance: provenanceSchema,
		representation: representationSchema,
		contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
		objectKey: z.string().min(1).max(1_024),
		retrievedAt: z
			.string()
			.datetime({ offset: true })
			.transform((value) => new Date(value)),
	})
	.strict();
const negativeSchema = z
	.object({
		kind: z.literal("negative"),
		provenance: provenanceSchema,
		retrievedAt: z
			.string()
			.datetime({ offset: true })
			.transform((value) => new Date(value)),
	})
	.strict();
const stateSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("positive"), positive: positiveSchema }).strict(),
	z
		.object({
			kind: z.literal("negative"),
			negative: negativeSchema,
			superseded: positiveSchema.nullable(),
		})
		.strict(),
	z
		.object({
			kind: z.literal("reversal_pending"),
			superseded: positiveSchema,
			firstNegative: negativeSchema,
		})
		.strict(),
]);
const stateRowSchema = z.object({ state_json: z.string().min(1).max(8_192) }).strict();
const versionRowSchema = z
	.object({
		metadata_json: z.string().min(1).max(4_096),
		object_key: z.string().min(1).max(1_024),
		representation: representationSchema,
	})
	.strict();

export function parseOpinionSourceState(
	row: unknown,
): Exclude<OpinionSourceCacheState, { readonly kind: "empty" }> {
	const parsedRow = stateRowSchema.safeParse(row);
	if (!parsedRow.success) throw new OpinionSourceCacheCorruptError();
	const parsedState = stateSchema.safeParse(jsonValue(parsedRow.data.state_json));
	if (!parsedState.success) throw new OpinionSourceCacheCorruptError();
	return parsedState.data;
}

export function parseOpinionSourceVersion(row: unknown): {
	readonly metadata: PositiveOpinionSourceObservation;
	readonly objectKey: string;
} {
	const parsedRow = versionRowSchema.safeParse(row);
	if (!parsedRow.success) throw new OpinionSourceCacheCorruptError();
	const metadata = positiveSchema.safeParse(jsonValue(parsedRow.data.metadata_json));
	if (
		!metadata.success ||
		metadata.data.objectKey !== parsedRow.data.object_key ||
		metadata.data.representation !== parsedRow.data.representation
	)
		throw new OpinionSourceCacheCorruptError();
	return { metadata: metadata.data, objectKey: parsedRow.data.object_key };
}

export function validateOpinionSourceState(
	state: Exclude<OpinionSourceCacheState, { readonly kind: "empty" }>,
	expected: OpinionSourceProvenance,
): void {
	for (const provenance of stateProvenance(state)) {
		if (
			provenance.opinionId !== expected.opinionId ||
			provenance.clusterId !== expected.clusterId ||
			provenance.canonicalUrl !== expected.canonicalUrl
		)
			throw new OpinionSourceCacheCorruptError();
	}
}

function stateProvenance(
	state: Exclude<OpinionSourceCacheState, { readonly kind: "empty" }>,
): readonly OpinionSourceProvenance[] {
	switch (state.kind) {
		case "positive":
			return [state.positive.provenance];
		case "negative":
			return [
				state.negative.provenance,
				...(state.superseded === null ? [] : [state.superseded.provenance]),
			];
		case "reversal_pending":
			return [state.firstNegative.provenance, state.superseded.provenance];
		default:
			return assertNever(state);
	}
}

function jsonValue(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch (error) {
		if (error instanceof SyntaxError) throw new OpinionSourceCacheCorruptError();
		throw error;
	}
}

function isCourtListenerUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			(url.hostname === "courtlistener.com" || url.hostname === "www.courtlistener.com")
		);
	} catch {
		return false;
	}
}

function assertNever(value: never): never {
	throw new TypeError(`Unexpected opinion source cache state: ${JSON.stringify(value)}`);
}

export class OpinionSourceCacheCorruptError extends Error {
	readonly name = "OpinionSourceCacheCorruptError";

	constructor() {
		super("opinion source cache state is corrupt");
	}
}

import { z } from "zod";
import type { CitationSourceCacheState } from "../verification/citation-source-cache.js";
import type { StoredCitationObservation } from "./citation-observation-store.js";

const canonicalUrlSchema = z.string().url().max(2_048).refine(isCourtListenerCanonicalUrl);
const storedStateSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("positive"),
		positive: positiveSchema(),
	}),
	z.object({
		kind: z.literal("negative"),
		negative: negativeSchema(),
		superseded: positiveSchema().nullable(),
	}),
	z.object({
		kind: z.literal("reversal_pending"),
		superseded: positiveSchema(),
		firstNegative: negativeSchema(),
	}),
]);

export function parseCitationSourceState(value: string): StoredCitationObservation {
	if (value.length === 0 || value.length > 4096) throw new CitationSourceStateCorruptError();
	const state = storedStateSchema.safeParse(jsonValue(value));
	if (!state.success) throw new CitationSourceStateCorruptError();
	return state.data;
}

function positiveSchema() {
	return z.object({
		kind: z.literal("positive"),
		cluster: z.object({
			id: z.number().int().positive(),
			canonicalUrl: canonicalUrlSchema,
		}),
		retrievedAt: z
			.string()
			.datetime({ offset: true })
			.transform((value) => new Date(value)),
	});
}

function negativeSchema() {
	return z.object({
		kind: z.literal("negative"),
		retrievedAt: z
			.string()
			.datetime({ offset: true })
			.transform((value) => new Date(value)),
	});
}

function jsonValue(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch (error) {
		if (error instanceof SyntaxError) throw new CitationSourceStateCorruptError();
		throw error;
	}
}

export function requireStoredState(state: CitationSourceCacheState): StoredCitationObservation {
	if (state.kind === "empty") throw new CitationSourceStateCorruptError();
	return state;
}

function isCourtListenerCanonicalUrl(value: string): boolean {
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

export class CitationSourceStateCorruptError extends Error {
	readonly name = "CitationSourceStateCorruptError";

	constructor() {
		super("citation source cache state is corrupt");
	}
}

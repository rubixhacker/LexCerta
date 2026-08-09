import { z } from "zod";
import {
	initialCitationSourceCacheState,
	recordCitationSourceObservation,
} from "../verification/citation-source-cache.js";
import type {
	CitationSourceCacheState,
	CitationSourceObservation,
} from "../verification/citation-source-cache.js";
import { CITATION_FETCH_LEASE_MS } from "./citation-observation-store.js";
import type {
	CitationObservationStore,
	LeaseAcquireResult,
	LeaseFillResult,
	LeaseReleaseResult,
	StoredCitationObservation,
} from "./citation-observation-store.js";

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

const stateRowSchema = z.object({ state_json: z.string().min(1).max(4_096) });
const leaseRowSchema = z.object({ expires_at: z.string().datetime({ offset: true }) });

export function createD1CitationObservationStore(database: D1Database): CitationObservationStore {
	return {
		read: async ({ normalizedCitation }) => readState(database, normalizedCitation),
		acquireLease: async (input) => acquireLease(database, input),
		fillLease: async (input) => fillLease(database, input),
		releaseLease: async ({ normalizedCitation, ownerToken }) => {
			const result = await database
				.prepare(
					"DELETE FROM citation_fetch_leases WHERE normalized_citation = ?1 AND owner_token = ?2",
				)
				.bind(normalizedCitation, ownerToken)
				.run();
			return changes(result) === 1 ? { kind: "released" } : { kind: "lease_unavailable" };
		},
	};
}

async function acquireLease(
	database: D1Database,
	input: { readonly normalizedCitation: string; readonly ownerToken: string; readonly now: Date },
): Promise<LeaseAcquireResult> {
	const now = input.now.toISOString();
	const expiresAt = new Date(input.now.getTime() + CITATION_FETCH_LEASE_MS).toISOString();
	const result = await database
		.prepare(
			"INSERT INTO citation_fetch_leases (normalized_citation, owner_token, expires_at) VALUES (?1, ?2, ?3) ON CONFLICT(normalized_citation) DO UPDATE SET owner_token = excluded.owner_token, expires_at = excluded.expires_at WHERE citation_fetch_leases.expires_at <= ?4",
		)
		.bind(input.normalizedCitation, input.ownerToken, expiresAt, now)
		.run();
	if (changes(result) === 1) return { kind: "acquired", expiresAt };
	const held = await database
		.prepare("SELECT expires_at FROM citation_fetch_leases WHERE normalized_citation = ?1")
		.bind(input.normalizedCitation)
		.first<unknown>();
	if (held === null) return acquireLease(database, input);
	const parsed = leaseRowSchema.safeParse(held);
	if (!parsed.success) throw new CitationSourceStateCorruptError();
	return { kind: "held", expiresAt: parsed.data.expires_at };
}

async function fillLease(
	database: D1Database,
	input: {
		readonly normalizedCitation: string;
		readonly ownerToken: string;
		readonly now: Date;
		readonly observation: CitationSourceObservation;
	},
): Promise<LeaseFillResult> {
	const current =
		(await readState(database, input.normalizedCitation)) ?? initialCitationSourceCacheState();
	const state = recordCitationSourceObservation({
		state: current,
		observation: input.observation,
		now: input.now,
	});
	const now = input.now.toISOString();
	const saved = JSON.stringify(state);
	const results = await database.batch([
		database
			.prepare(
				"INSERT INTO citation_source_states (normalized_citation, state_json, updated_at) SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM citation_fetch_leases WHERE normalized_citation = ?1 AND owner_token = ?4 AND expires_at > ?3) ON CONFLICT(normalized_citation) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at WHERE EXISTS (SELECT 1 FROM citation_fetch_leases WHERE normalized_citation = ?1 AND owner_token = ?4 AND expires_at > ?3)",
			)
			.bind(input.normalizedCitation, saved, now, input.ownerToken),
		database
			.prepare(
				"DELETE FROM citation_fetch_leases WHERE normalized_citation = ?1 AND owner_token = ?2 AND expires_at > ?3",
			)
			.bind(input.normalizedCitation, input.ownerToken, now),
	]);
	return changes(results[0]) === 1
		? { kind: "stored", observation: requireStoredState(state) }
		: { kind: "lease_unavailable" };
}

async function readState(
	database: D1Database,
	normalizedCitation: string,
): Promise<StoredCitationObservation | null> {
	const row = await database
		.prepare("SELECT state_json FROM citation_source_states WHERE normalized_citation = ?1")
		.bind(normalizedCitation)
		.first<unknown>();
	if (row === null) return null;
	const parsedRow = stateRowSchema.safeParse(row);
	if (!parsedRow.success) throw new CitationSourceStateCorruptError();
	const value = jsonValue(parsedRow.data.state_json);
	const state = storedStateSchema.safeParse(value);
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

function requireStoredState(state: CitationSourceCacheState): StoredCitationObservation {
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

function changes(result: D1Result<unknown> | undefined): number {
	const value = result?.meta.changes;
	return typeof value === "number" ? value : 0;
}

export class CitationSourceStateCorruptError extends Error {
	readonly name = "CitationSourceStateCorruptError";

	constructor() {
		super("citation source cache state is corrupt");
	}
}

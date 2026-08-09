import { z } from "zod";
import { OPINION_FETCH_LEASE_MS } from "./opinion-cache-store.js";
import type {
	CachedOpinion,
	OpinionCacheStore,
	OpinionLeaseAcquireResult,
	OpinionLeaseFillResult,
	OpinionLeaseReleaseResult,
} from "./opinion-cache-store.js";

const representationSchema = z.enum(["html_with_citations", "html", "plain_text"]);
const metadataRowSchema = z.object({
	opinion_id: z.number().int().positive(),
	cluster_id: z.number().int().positive(),
	canonical_url: z.string().url().max(2_048).refine(isCourtListenerCanonicalUrl),
	representation: representationSchema,
	retrieved_at: z
		.string()
		.datetime({ offset: true })
		.transform((value) => new Date(value)),
	fresh_until: z
		.string()
		.datetime({ offset: true })
		.transform((value) => new Date(value)),
	content_sha256: z.string().regex(/^[0-9a-f]{64}$/),
	object_key: z.string().min(1).max(1_024),
});
const leaseRowSchema = z.object({ expires_at: z.string().datetime({ offset: true }) });
const cachedOpinionSchema = z.object({
	opinionId: z.number().int().positive(),
	clusterId: z.number().int().positive(),
	canonicalUrl: z.string().url().max(2_048).refine(isCourtListenerCanonicalUrl),
	representation: representationSchema,
	retrievedAt: z.date(),
	freshUntil: z.date(),
	sourceText: z.string().min(1),
});

export function createD1R2OpinionCacheStore(input: {
	readonly database: D1Database;
	readonly opinions: R2Bucket;
}): OpinionCacheStore {
	return {
		read: async ({ opinionId }) => readOpinion(input, opinionId),
		acquireLease: async (lease) => acquireLease(input.database, lease),
		fillLease: async (fill) => fillLease(input, fill),
		releaseLease: async ({ opinionId, ownerToken }) =>
			releaseLease(input.database, opinionId, ownerToken),
	};
}

async function readOpinion(
	input: { readonly database: D1Database; readonly opinions: R2Bucket },
	opinionId: number,
): Promise<CachedOpinion | null> {
	const row = await input.database
		.prepare(
			"SELECT opinion_id, cluster_id, canonical_url, representation, retrieved_at, fresh_until, content_sha256, object_key FROM opinion_source_metadata WHERE opinion_id = ?1",
		)
		.bind(opinionId)
		.first<unknown>();
	if (row === null) return null;
	const metadata = parseMetadata(row);
	const object = await input.opinions.get(metadata.object_key);
	if (object === null) return null;
	const sourceText = await object.text();
	if (sourceText.length === 0 || (await sha256(sourceText)) !== metadata.content_sha256) {
		throw new OpinionSourceCacheCorruptError();
	}
	return {
		opinionId: metadata.opinion_id,
		clusterId: metadata.cluster_id,
		canonicalUrl: metadata.canonical_url,
		representation: metadata.representation,
		retrievedAt: metadata.retrieved_at,
		freshUntil: metadata.fresh_until,
		sourceText,
	};
}

async function acquireLease(
	database: D1Database,
	input: { readonly opinionId: number; readonly ownerToken: string; readonly now: Date },
): Promise<OpinionLeaseAcquireResult> {
	const now = input.now.toISOString();
	const expiresAt = new Date(input.now.getTime() + OPINION_FETCH_LEASE_MS).toISOString();
	const claimed = await database
		.prepare(
			"INSERT INTO opinion_fetch_leases (opinion_id, owner_token, expires_at) VALUES (?1, ?2, ?3) ON CONFLICT(opinion_id) DO UPDATE SET owner_token = excluded.owner_token, expires_at = excluded.expires_at WHERE opinion_fetch_leases.expires_at <= ?4",
		)
		.bind(input.opinionId, input.ownerToken, expiresAt, now)
		.run();
	if (changes(claimed) === 1) return { kind: "acquired", expiresAt };
	const held = await database
		.prepare("SELECT expires_at FROM opinion_fetch_leases WHERE opinion_id = ?1")
		.bind(input.opinionId)
		.first<unknown>();
	if (held === null) return acquireLease(database, input);
	const parsed = leaseRowSchema.safeParse(held);
	if (!parsed.success) throw new OpinionSourceCacheCorruptError();
	return { kind: "held", expiresAt: parsed.data.expires_at };
}

async function fillLease(
	input: { readonly database: D1Database; readonly opinions: R2Bucket },
	fill: { readonly ownerToken: string; readonly now: Date; readonly opinion: CachedOpinion },
): Promise<OpinionLeaseFillResult> {
	const opinion = parseOpinion(fill.opinion);
	const now = fill.now.toISOString();
	if (!(await ownsActiveLease(input.database, opinion.opinionId, fill.ownerToken, now))) {
		return { kind: "lease_unavailable" };
	}
	const contentSha256 = await sha256(opinion.sourceText);
	const objectKey = `opinions/${opinion.opinionId}/${contentSha256}`;
	await input.opinions.put(objectKey, opinion.sourceText);
	const results = await input.database.batch([
		input.database
			.prepare(
				"INSERT INTO opinion_source_metadata (opinion_id, cluster_id, canonical_url, representation, retrieved_at, fresh_until, content_sha256, object_key) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8 WHERE EXISTS (SELECT 1 FROM opinion_fetch_leases WHERE opinion_id = ?1 AND owner_token = ?9 AND expires_at > ?10) ON CONFLICT(opinion_id) DO UPDATE SET cluster_id = excluded.cluster_id, canonical_url = excluded.canonical_url, representation = excluded.representation, retrieved_at = excluded.retrieved_at, fresh_until = excluded.fresh_until, content_sha256 = excluded.content_sha256, object_key = excluded.object_key WHERE EXISTS (SELECT 1 FROM opinion_fetch_leases WHERE opinion_id = ?1 AND owner_token = ?9 AND expires_at > ?10)",
			)
			.bind(
				opinion.opinionId,
				opinion.clusterId,
				opinion.canonicalUrl,
				opinion.representation,
				opinion.retrievedAt.toISOString(),
				opinion.freshUntil.toISOString(),
				contentSha256,
				objectKey,
				fill.ownerToken,
				now,
			),
		input.database
			.prepare(
				"DELETE FROM opinion_fetch_leases WHERE opinion_id = ?1 AND owner_token = ?2 AND expires_at > ?3",
			)
			.bind(opinion.opinionId, fill.ownerToken, now),
	]);
	return changes(results[0]) === 1 ? { kind: "stored", opinion } : { kind: "lease_unavailable" };
}

async function releaseLease(
	database: D1Database,
	opinionId: number,
	ownerToken: string,
): Promise<OpinionLeaseReleaseResult> {
	const released = await database
		.prepare("DELETE FROM opinion_fetch_leases WHERE opinion_id = ?1 AND owner_token = ?2")
		.bind(opinionId, ownerToken)
		.run();
	return changes(released) === 1 ? { kind: "released" } : { kind: "lease_unavailable" };
}

async function ownsActiveLease(
	database: D1Database,
	opinionId: number,
	ownerToken: string,
	now: string,
): Promise<boolean> {
	const lease = await database
		.prepare(
			"SELECT 1 FROM opinion_fetch_leases WHERE opinion_id = ?1 AND owner_token = ?2 AND expires_at > ?3",
		)
		.bind(opinionId, ownerToken, now)
		.first<unknown>();
	return lease !== null;
}

function parseMetadata(value: unknown): z.infer<typeof metadataRowSchema> {
	const result = metadataRowSchema.safeParse(value);
	if (!result.success) throw new OpinionSourceCacheCorruptError();
	return result.data;
}

function parseOpinion(value: CachedOpinion): CachedOpinion {
	const result = cachedOpinionSchema.safeParse(value);
	if (!result.success) throw new OpinionSourceCacheInvalidFillError();
	return result.data;
}

function isCourtListenerCanonicalUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			(url.hostname === "courtlistener.com" || url.hostname === "www.courtlistener.com")
		);
	} catch (error) {
		if (error instanceof TypeError) return false;
		throw error;
	}
}

function changes(result: D1Result<unknown> | undefined): number {
	const value = result?.meta.changes;
	return typeof value === "number" ? value : 0;
}

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class OpinionSourceCacheCorruptError extends Error {
	readonly name = "OpinionSourceCacheCorruptError";

	constructor() {
		super("opinion source cache is corrupt");
	}
}

export class OpinionSourceCacheInvalidFillError extends Error {
	readonly name = "OpinionSourceCacheInvalidFillError";

	constructor() {
		super("opinion source cache fill is invalid");
	}
}

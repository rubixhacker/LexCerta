import {
	initialOpinionSourceCacheState,
	recordOpinionSourceObservation,
} from "../verification/opinion-source-cache.js";
import type {
	OpinionSourceCacheState,
	OpinionSourceObservation,
	OpinionSourceProvenance,
	PositiveOpinionSourceObservation,
} from "../verification/opinion-source-cache.js";
import {
	OpinionSourceCacheCorruptError,
	parseOpinionSourceState,
	parseOpinionSourceVersion,
	validateOpinionSourceState,
} from "./opinion-source-record.js";
import { purgeExpiredNegativeLease } from "./d1-opinion-source-purge.js";
import {
	contentHash,
	deleteStagedOpinionSourceObject,
	prepareOpinionSourceObject,
} from "./opinion-source-object.js";
import { OPINION_SOURCE_FETCH_LEASE_MS } from "./opinion-source-store.js";
import type {
	OpinionSourceLeaseAcquireResult,
	OpinionSourceLeaseFillResult,
	OpinionSourceReadResult,
	OpinionSourceStore,
	OpinionSourceWriteObservation,
} from "./opinion-source-store.js";

import { z } from "zod";

const leaseRowSchema = z.object({ expires_at: z.string().datetime({ offset: true }) }).strict();

export function createD1R2OpinionSourceStore(input: {
	readonly bucket: R2Bucket;
	readonly database: D1Database;
}): OpinionSourceStore {
	return {
		read: async ({ provenance }) => read(input, provenance),
		acquireLease: async (lease) => acquireLease(input.database, lease),
		fillLease: async (fill) => fillLease(input, fill),
		purgeExpiredNegativeLease: async (purge) => purgeExpiredNegativeLease(input.database, purge),
		releaseLease: async ({ now, opinionId, ownerToken }) =>
			releaseLease(input.database, opinionId, ownerToken, now),
	};
}

async function read(
	input: { readonly bucket: R2Bucket; readonly database: D1Database },
	provenance: OpinionSourceProvenance,
): Promise<OpinionSourceReadResult | null> {
	const state = await readState(input.database, provenance.opinionId);
	if (state === null) return null;
	validateOpinionSourceState(state, provenance);
	if (state.kind !== "positive") return { kind: "state", state };
	const object = await input.bucket.get(state.positive.objectKey);
	if (object === null) throw new OpinionSourceCacheCorruptError();
	const sourceText = await object.text();
	if ((await contentHash(sourceText)) !== state.positive.contentHash)
		throw new OpinionSourceCacheCorruptError();
	await validateVersion(input.database, state.positive);
	return { kind: "positive", state, sourceText };
}

async function acquireLease(
	database: D1Database,
	input: { readonly now: Date; readonly opinionId: number; readonly ownerToken: string },
	retried = false,
): Promise<OpinionSourceLeaseAcquireResult> {
	const now = input.now.toISOString();
	const expiresAt = new Date(input.now.getTime() + OPINION_SOURCE_FETCH_LEASE_MS).toISOString();
	const result = await database
		.prepare(
			"INSERT INTO opinion_source_fetch_leases (opinion_id, owner_token, expires_at) VALUES (?1, ?2, ?3) ON CONFLICT(opinion_id) DO UPDATE SET owner_token = excluded.owner_token, expires_at = excluded.expires_at WHERE opinion_source_fetch_leases.expires_at <= ?4",
		)
		.bind(input.opinionId, input.ownerToken, expiresAt, now)
		.run();
	if (changes(result) === 1) return { kind: "acquired", expiresAt };
	const held = await database
		.prepare("SELECT expires_at FROM opinion_source_fetch_leases WHERE opinion_id = ?1")
		.bind(input.opinionId)
		.first<unknown>();
	if (held === null && !retried) return acquireLease(database, input, true);
	if (held === null) throw new OpinionSourceCacheCorruptError();
	const parsed = leaseRowSchema.safeParse(held);
	if (!parsed.success) throw new OpinionSourceCacheCorruptError();
	return { kind: "held", expiresAt: parsed.data.expires_at };
}

async function fillLease(
	input: { readonly bucket: R2Bucket; readonly database: D1Database },
	fill: {
		readonly now: Date;
		readonly ownerToken: string;
		readonly observation: OpinionSourceWriteObservation;
	},
): Promise<OpinionSourceLeaseFillResult> {
	const prepared = await prepareOpinionSourceObject({
		bucket: input.bucket,
		database: input.database,
		ownerToken: fill.ownerToken,
		observation: fill.observation,
	});
	const observation = prepared.observation;
	const existing = await readState(input.database, fill.observation.provenance.opinionId);
	if (existing !== null) validateOpinionSourceState(existing, fill.observation.provenance);
	const current = existing ?? initialOpinionSourceCacheState();
	const state = recordOpinionSourceObservation({ now: fill.now, observation, state: current });
	const storedState = requireStoredState(state);
	const activePositive = storedState.kind === "positive" ? storedState.positive : null;
	const serialized = JSON.stringify(state);
	const now = fill.now.toISOString();
	const opinionId = fill.observation.provenance.opinionId;
	let results: readonly D1Result<unknown>[];
	try {
		results = await input.database.batch([
			input.database
				.prepare(
					"INSERT OR IGNORE INTO opinion_source_object_versions (opinion_id, content_sha256_hex, object_key, metadata_json, stored_at) SELECT ?1, ?2, ?3, ?4, ?5 WHERE ?6 IS NOT NULL AND EXISTS (SELECT 1 FROM opinion_source_fetch_leases WHERE opinion_id = ?1 AND owner_token = ?7 AND expires_at > ?5)",
				)
				.bind(
					opinionId,
					activePositive === null ? "" : hashHex(activePositive),
					activePositive?.objectKey ?? "",
					activePositive === null ? "" : JSON.stringify(activePositive),
					now,
					activePositive === null ? null : 1,
					fill.ownerToken,
				),
			input.database
				.prepare(
					"INSERT INTO opinion_source_states (opinion_id, state_json, updated_at) SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM opinion_source_fetch_leases WHERE opinion_id = ?1 AND owner_token = ?4 AND expires_at > ?3) ON CONFLICT(opinion_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at WHERE EXISTS (SELECT 1 FROM opinion_source_fetch_leases WHERE opinion_id = ?1 AND owner_token = ?4 AND expires_at > ?3)",
				)
				.bind(opinionId, serialized, now, fill.ownerToken),
			input.database
				.prepare(
					"DELETE FROM opinion_source_fetch_leases WHERE opinion_id = ?1 AND owner_token = ?2 AND expires_at > ?3",
				)
				.bind(opinionId, fill.ownerToken, now),
		]);
	} catch (error) {
		await deleteStagedOpinionSourceObject(input.bucket, prepared);
		throw error;
	}
	return changes(results[1]) === 1
		? { kind: "stored", state: storedState }
		: await lostLease(input.bucket, prepared);
}

async function readState(
	database: D1Database,
	opinionId: number,
): Promise<Exclude<OpinionSourceCacheState, { readonly kind: "empty" }> | null> {
	const row = await database
		.prepare("SELECT state_json FROM opinion_source_states WHERE opinion_id = ?1")
		.bind(opinionId)
		.first<unknown>();
	if (row === null) return null;
	return parseOpinionSourceState(row);
}

async function validateVersion(
	database: D1Database,
	positive: PositiveOpinionSourceObservation,
): Promise<void> {
	const row = await database
		.prepare(
			"SELECT object_key, metadata_json FROM opinion_source_object_versions WHERE opinion_id = ?1 AND content_sha256_hex = ?2",
		)
		.bind(positive.provenance.opinionId, hashHex(positive))
		.first<unknown>();
	if (row === null) throw new OpinionSourceCacheCorruptError();
	const version = parseOpinionSourceVersion(row);
	if (
		version.objectKey !== positive.objectKey ||
		JSON.stringify(version.metadata) !== JSON.stringify(positive)
	)
		throw new OpinionSourceCacheCorruptError();
}

async function releaseLease(
	database: D1Database,
	opinionId: number,
	ownerToken: string,
	now: Date,
) {
	const result = await database
		.prepare(
			"DELETE FROM opinion_source_fetch_leases WHERE opinion_id = ?1 AND owner_token = ?2 AND expires_at > ?3",
		)
		.bind(opinionId, ownerToken, now.toISOString())
		.run();
	return changes(result) === 1
		? { kind: "released" as const }
		: { kind: "lease_unavailable" as const };
}

function hashHex(observation: OpinionSourceObservation | PositiveOpinionSourceObservation): string {
	return observation.kind === "positive" ? observation.contentHash.slice("sha256:".length) : "";
}
function requireStoredState(
	state: OpinionSourceCacheState,
): Exclude<OpinionSourceCacheState, { readonly kind: "empty" }> {
	if (state.kind === "empty") throw new OpinionSourceCacheCorruptError();
	return state;
}
async function lostLease(
	bucket: R2Bucket,
	prepared: Parameters<typeof deleteStagedOpinionSourceObject>[1],
) {
	await deleteStagedOpinionSourceObject(bucket, prepared);
	return { kind: "lease_unavailable" as const };
}
function changes(result: D1Result<unknown> | undefined): number {
	const value = result?.meta.changes;
	return typeof value === "number" ? value : 0;
}
export { OpinionSourceCacheCorruptError } from "./opinion-source-record.js";

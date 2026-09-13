import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	parseOpinionSourceState,
	validateOpinionSourceState,
} from "../cache/opinion-source-record.js";
import type {
	OpinionSourceStore,
	OpinionSourceWriteObservation,
} from "../cache/opinion-source-store.js";
import {
	type OpinionSourceCacheState,
	type OpinionSourceProvenance,
	initialOpinionSourceCacheState,
	purgeExpiredOpinionNegative,
	recordOpinionSourceObservation,
} from "../verification/opinion-source-cache.js";
import type { PgTransaction, TransactionDatabase } from "./database.js";
import {
	type ListedSourceObject,
	MAX_SOURCE_OBJECT_BYTES,
	SourceObjectIntegrityError,
	type SourceObjectMetadata,
	type SourceObjectVersion,
	type SourceObjects,
	sameMetadata,
	sourceHash,
} from "./objects.js";

type OpinionRow = {
	state: unknown;
	epoch: string;
	owner_token: string | null;
	lease_expires_at: Date | null;
	body_key: string | null;
	removed_at: Date | null;
};
type ObjectRow = {
	object_key: string;
	opinion_id: string;
	epoch: string;
	content_hash: string;
	representation: string;
	byte_size: number;
	generation: string | null;
	acquired_at: Date;
	expires_at: Date;
	phase: "uploading" | "ready" | "deleting";
	delete_token: string | null;
};
type StoredState = Exclude<OpinionSourceCacheState, { kind: "empty" }>;
type Capacity = { max_opinions: number; max_bytes: string };
type Publication =
	| { kind: "negative"; provenance: OpinionSourceProvenance }
	| {
			kind: "positive";
			observation: Extract<OpinionSourceWriteObservation, { kind: "positive" }>;
			reservation: ObjectRow;
			generation: string;
	  };

export class PostgresOpinionSources implements OpinionSourceStore {
	constructor(
		private readonly database: TransactionDatabase,
		private readonly objects: SourceObjects,
	) {}

	async read({ provenance }: Parameters<OpinionSourceStore["read"]>[0]) {
		const snapshot = await this.database.transaction(async (transaction) => {
			const row = (
				await transaction.query<OpinionRow>(
					"SELECT state, epoch, body_key, removed_at FROM lexcerta.opinion_sources WHERE opinion_id = $1",
					[provenance.opinionId],
				)
			).rows[0];
			if (row?.removed_at) throw new Error("opinion source removed");
			const state = parsed(row?.state);
			if (state === null) return null;
			validateOpinionSourceState(state, provenance);
			if (state.kind !== "positive") return { kind: "state" as const, state };
			if (!row?.body_key) return null;
			const object = await objectRow(transaction, row.body_key);
			if (object === undefined || object.phase !== "ready" || object.generation === null)
				throw new SourceObjectIntegrityError();
			if (object.expires_at <= (await transaction.now())) return null;
			if (
				state.positive.objectKey !== object.object_key ||
				state.positive.contentHash !== object.content_hash
			)
				throw new SourceObjectIntegrityError();
			return { kind: "body" as const, state, object };
		});
		if (snapshot === null || snapshot.kind === "state") return snapshot;
		const object = await this.objects.read(
			snapshot.object.object_key,
			snapshot.object.generation ?? "",
		);
		if (object === null) throw new SourceObjectIntegrityError();
		verifyObject(object, snapshot.object, provenance);
		// A GC, tombstone or new publication during object I/O invalidates this read.
		const current = await this.database.transaction(async (transaction) => {
			const result = await transaction.query(
				"SELECT 1 FROM lexcerta.opinion_sources s JOIN lexcerta.source_objects o ON o.object_key = s.body_key WHERE s.opinion_id = $1 AND s.body_key = $2 AND s.removed_at IS NULL AND o.phase = 'ready' AND o.generation = $3 AND o.expires_at > clock_timestamp()",
				[provenance.opinionId, snapshot.object.object_key, object.generation],
			);
			return result.rowCount === 1;
		});
		if (!current) return null;
		return {
			kind: "positive" as const,
			state: snapshot.state,
			sourceText: new TextDecoder("utf-8", { fatal: true }).decode(object.bytes),
		};
	}

	async acquireLease({ opinionId, ownerToken }: Parameters<OpinionSourceStore["acquireLease"]>[0]) {
		return this.database.transaction(async (transaction) => {
			await transaction.query(
				"INSERT INTO lexcerta.opinion_sources(opinion_id) VALUES ($1) ON CONFLICT DO NOTHING",
				[opinionId],
			);
			const row = await lockOpinion(transaction, opinionId);
			if (row.removed_at !== null) throw new Error("opinion source removed");
			const now = await transaction.now();
			if (row.lease_expires_at !== null && row.lease_expires_at > now)
				return { kind: "held" as const, expiresAt: row.lease_expires_at.toISOString() };
			const expires = new Date(now.getTime() + 10_000);
			await transaction.query(
				"UPDATE lexcerta.opinion_sources SET epoch = epoch + 1, owner_token = $2, lease_expires_at = $3 WHERE opinion_id = $1",
				[opinionId, ownerToken, expires],
			);
			return { kind: "acquired" as const, expiresAt: expires.toISOString() };
		});
	}

	async fillLease(input: Parameters<OpinionSourceStore["fillLease"]>[0]) {
		if (input.observation.kind === "negative")
			return this.publish(input.ownerToken, input.observation);
		const bytes = new TextEncoder().encode(input.observation.sourceText);
		if (bytes.byteLength < 1 || bytes.byteLength > MAX_SOURCE_OBJECT_BYTES)
			throw new SourceObjectIntegrityError();
		const hash = sourceHash(bytes);
		let reservation = await this.reserveObject(
			input.ownerToken,
			input.observation,
			bytes.byteLength,
			hash,
		);
		if (reservation === "capacity") {
			// Leave enough of the ten-second lease for the upload and publication.
			await this.collectGarbage(1, true, 1000);
			reservation = await this.reserveObject(
				input.ownerToken,
				input.observation,
				bytes.byteLength,
				hash,
			);
		}
		if (reservation === null || reservation === "capacity")
			return { kind: "lease_unavailable" as const };
		const stored = await this.objects.put(
			reservation.object_key,
			bytes,
			metadataFor(reservation, input.observation.provenance),
		);
		verifyObject(stored, reservation, input.observation.provenance);
		return this.publish(input.ownerToken, {
			kind: "positive",
			observation: input.observation,
			reservation,
			generation: stored.generation,
		});
	}

	private async reserveObject(
		owner: string,
		observation: Extract<OpinionSourceWriteObservation, { kind: "positive" }>,
		byteSize: number,
		hash: string,
	): Promise<ObjectRow | "capacity" | null> {
		return this.database.transaction(async (transaction) => {
			const capacity = await lockCapacity(transaction);
			const row = await lockOpinion(transaction, observation.provenance.opinionId);
			const now = await transaction.now();
			if (!owns(row, owner, now)) return null;
			const state = parsed(row.state);
			if (state !== null) validateOpinionSourceState(state, observation.provenance);
			const usage = (
				await transaction.query<{ bytes: string; opinions: string; existing: boolean }>(
					"SELECT coalesce(sum(byte_size),0)::text AS bytes, count(DISTINCT opinion_id)::text AS opinions, coalesce(bool_or(opinion_id = $1),false) AS existing FROM lexcerta.source_objects",
					[observation.provenance.opinionId],
				)
			).rows[0];
			if (usage === undefined) throw new SourceObjectIntegrityError();
			if (
				Number(usage.bytes) + byteSize > Number(capacity.max_bytes) ||
				Number(usage.opinions) + (usage.existing ? 0 : 1) > capacity.max_opinions
			)
				return "capacity";
			const acquired = new Date((row.lease_expires_at?.getTime() ?? now.getTime()) - 10_000);
			const key = `opinions/${observation.provenance.opinionId}/${hash.slice(7)}/${row.epoch}-${randomUUID()}`;
			if (
				(
					await transaction.query(
						"SELECT 1 FROM lexcerta.orphan_object_deletions WHERE object_key = $1",
						[key],
					)
				).rowCount !== 0
			)
				throw new SourceObjectIntegrityError();
			const result = await transaction.query<ObjectRow>(
				"INSERT INTO lexcerta.source_objects(object_key, opinion_id, epoch, content_hash, representation, byte_size, acquired_at, expires_at, phase) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'uploading') RETURNING *",
				[
					key,
					observation.provenance.opinionId,
					row.epoch,
					hash,
					observation.representation,
					byteSize,
					acquired,
					new Date(acquired.getTime() + 30 * 86_400_000),
				],
			);
			const object = result.rows[0];
			if (object === undefined) throw new SourceObjectIntegrityError();
			return object;
		});
	}

	private async publish(ownerToken: string, publication: Publication) {
		const provenance =
			publication.kind === "negative" ? publication.provenance : publication.observation.provenance;
		const reservation = publication.kind === "positive" ? publication.reservation : null;
		return this.database.transaction(async (transaction) => {
			await lockCapacity(transaction);
			const opinionId = provenance.opinionId;
			const row = await lockOpinion(transaction, opinionId);
			const now = await transaction.now();
			if (!owns(row, ownerToken, now) || (reservation !== null && row.epoch !== reservation.epoch))
				return { kind: "lease_unavailable" as const };
			const current = parsed(row.state);
			if (current !== null) validateOpinionSourceState(current, provenance);
			if (publication.kind === "positive") {
				const { reservation, generation } = publication;
				const staged = await objectRow(transaction, reservation.object_key);
				if (
					staged === undefined ||
					staged.phase !== "uploading" ||
					staged.epoch !== row.epoch ||
					staged.expires_at <= now
				)
					return { kind: "lease_unavailable" as const };
				await transaction.query(
					"UPDATE lexcerta.source_objects SET generation = $2, phase = 'ready' WHERE object_key = $1",
					[reservation.object_key, generation],
				);
			}
			const observation =
				publication.kind === "negative"
					? { kind: "negative" as const, provenance }
					: {
							kind: "positive" as const,
							provenance,
							representation: publication.observation.representation,
							contentHash: publication.reservation.content_hash,
							objectKey: publication.reservation.object_key,
						};
			const state = recordOpinionSourceObservation({
				state: current ?? initialOpinionSourceCacheState(),
				observation,
				now,
			});
			const stored = requireState(state);
			await transaction.query(
				"UPDATE lexcerta.opinion_sources SET state = $2, body_key = $3, owner_token = NULL, lease_expires_at = NULL, updated_at = $4 WHERE opinion_id = $1",
				[
					opinionId,
					JSON.stringify(stored),
					stored.kind === "positive" ? stored.positive.objectKey : null,
					now,
				],
			);
			return { kind: "stored" as const, state: stored };
		});
	}

	async purgeExpiredNegativeLease({
		opinionId,
		ownerToken,
		expected,
	}: Parameters<OpinionSourceStore["purgeExpiredNegativeLease"]>[0]) {
		return this.database.transaction(async (transaction) => {
			const row = await lockOpinion(transaction, opinionId);
			const now = await transaction.now();
			if (!owns(row, ownerToken, now)) return { kind: "lease_unavailable" as const };
			if (!isDeepStrictEqual(parsed(row.state), expected))
				return { kind: "state_changed" as const };
			const state = purgeExpiredOpinionNegative({ state: expected, now });
			await transaction.query(
				"UPDATE lexcerta.opinion_sources SET state = $2, body_key = NULL, updated_at = $3 WHERE opinion_id = $1",
				[opinionId, state.kind === "empty" ? null : JSON.stringify(state), now],
			);
			return { kind: "purged" as const, state: state.kind === "empty" ? null : state };
		});
	}

	async releaseLease({ opinionId, ownerToken }: Parameters<OpinionSourceStore["releaseLease"]>[0]) {
		return this.database.transaction(async (transaction) => {
			const result = await transaction.query(
				"UPDATE lexcerta.opinion_sources SET owner_token = NULL, lease_expires_at = NULL WHERE opinion_id = $1 AND owner_token = $2",
				[opinionId, ownerToken],
			);
			return result.rowCount === 1
				? { kind: "released" as const }
				: { kind: "lease_unavailable" as const };
		});
	}

	async collectGarbage(batchSize = 100, evict = false, budgetMs = 45_000): Promise<number> {
		if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100)
			throw new RangeError("invalid cleanup batch");
		const deadline = cleanupDeadline(budgetMs);
		const candidates = await this.database.transaction(async (transaction) => {
			await lockCapacity(transaction);
			const rows = await transaction.query<ObjectRow>(
				"SELECT * FROM lexcerta.source_objects WHERE (phase = 'deleting' AND coalesce(delete_after, '-infinity') <= clock_timestamp()) OR (phase <> 'deleting' AND (expires_at <= clock_timestamp() OR (acquired_at <= clock_timestamp() - interval '48 hours' AND NOT EXISTS (SELECT 1 FROM lexcerta.opinion_sources s WHERE s.body_key = object_key)) OR ($2 AND phase = 'ready'))) ORDER BY acquired_at, object_key LIMIT $1 FOR UPDATE SKIP LOCKED",
				[batchSize, evict],
			);
			const result = [];
			for (const row of rows.rows) {
				const token = randomUUID();
				await lockOpinion(transaction, Number(row.opinion_id));
				await transaction.query(
					"UPDATE lexcerta.opinion_sources SET body_key = NULL WHERE body_key = $1",
					[row.object_key],
				);
				await transaction.query(
					"UPDATE lexcerta.source_objects SET phase = 'deleting', delete_token = $2, delete_after = clock_timestamp() + interval '10 seconds' WHERE object_key = $1",
					[row.object_key, token],
				);
				result.push({ ...row, delete_token: token });
			}
			return result;
		});
		let deleted = 0;
		for (const row of candidates) {
			if (performance.now() >= deadline) break;
			const generation = row.generation ?? (await this.objects.generation(row.object_key));
			if (generation !== null) await this.objects.remove(row.object_key, generation);
			deleted += await this.database.transaction(async (transaction) => {
				await lockCapacity(transaction);
				const result = await transaction.query(
					"DELETE FROM lexcerta.source_objects WHERE object_key = $1 AND delete_token = $2 AND phase = 'deleting' AND NOT EXISTS (SELECT 1 FROM lexcerta.opinion_sources WHERE body_key = $1)",
					[row.object_key, row.delete_token],
				);
				return result.rowCount ?? 0;
			});
		}
		return deleted;
	}

	// Deleting rows awaiting their retry time still count as pending work.
	// A zero deletion count alone cannot establish completion of a sweep.
	async hasPendingGarbage(): Promise<boolean> {
		return this.database.transaction(async (transaction) => {
			const result = await transaction.query<{ pending: boolean }>(
				"SELECT EXISTS (SELECT 1 FROM lexcerta.source_objects o WHERE o.phase = 'deleting' OR o.expires_at <= clock_timestamp() OR (o.acquired_at <= clock_timestamp() - interval '48 hours' AND NOT EXISTS (SELECT 1 FROM lexcerta.opinion_sources s WHERE s.body_key = o.object_key))) AS pending",
			);
			return result.rows[0]?.pending !== false;
		});
	}

	// A bounded page scan also finds uploads completed after a tombstone, process
	// crash or database restore. The caller checkpoints nextPageToken between jobs.
	async collectOrphans(
		pageToken?: string,
		budgetMs = 45_000,
		after?: Pick<ListedSourceObject, "key" | "generation">,
	) {
		const deadline = cleanupDeadline(budgetMs);
		if (
			after !== undefined &&
			(after.key.length < 1 || after.key.length > 1024 || !/^[0-9]{1,32}$/.test(after.generation))
		)
			throw new SourceObjectIntegrityError();
		const pending = await this.database.transaction(async (transaction) => {
			const result = await transaction.query<{ object_key: string; generation: string }>(
				"SELECT object_key, generation FROM lexcerta.orphan_object_deletions ORDER BY marked_at LIMIT 100",
			);
			return result.rows.map((row) => ({
				key: row.object_key,
				generation: row.generation,
				createdAt: new Date(0),
			}));
		});
		const page = await this.objects.list(pageToken);
		// Persist a key within the page as well as the opaque provider token. A
		// slow page of protected objects must not restart forever after each budget.
		const candidates = [...page.objects]
			.sort(compareObjectVersions)
			.filter((object) => after === undefined || compareObjectVersions(object, after) > 0);
		let deleted = 0;
		const remove = async (object: ListedSourceObject) => {
			if (await this.claimOrphan(object)) {
				await this.objects.remove(object.key, object.generation);
				await this.database.transaction(async (transaction) => {
					await lockCapacity(transaction);
					await transaction.query(
						"DELETE FROM lexcerta.orphan_object_deletions WHERE object_key = $1 AND generation = $2",
						[object.key, object.generation],
					);
				});
				deleted += 1;
			}
		};
		// Marks recover a lost delete acknowledgement even if the provider no
		// longer lists that generation. They are never skipped by a page cursor.
		let recovered = 0;
		for (const object of pending) {
			if (performance.now() >= deadline) break;
			await remove(object);
			recovered += 1;
		}
		let scanned = 0;
		let last = after ?? null;
		for (const object of candidates) {
			if (performance.now() >= deadline) break;
			if (
				!pending
					.slice(0, recovered)
					.some((mark) => mark.key === object.key && mark.generation === object.generation)
			)
				await remove(object);
			scanned += 1;
			last = { key: object.key, generation: object.generation };
		}
		const remaining = await this.database.transaction(async (transaction) => {
			const result = await transaction.query<{ pending: boolean }>(
				"SELECT EXISTS (SELECT 1 FROM lexcerta.orphan_object_deletions) AS pending",
			);
			return result.rows[0]?.pending !== false;
		});
		const pageDone = scanned === candidates.length && !remaining;
		return {
			deleted,
			nextPageToken: pageDone ? page.nextPageToken : (pageToken ?? null),
			after: pageDone ? null : last,
			complete: pageDone && page.nextPageToken === null,
		};
	}

	private async claimOrphan(object: ListedSourceObject): Promise<boolean> {
		return this.database.transaction(async (transaction) => {
			await lockCapacity(transaction);
			const now = await transaction.now();
			if (object.createdAt.getTime() > now.getTime() - 48 * 3_600_000) return false;
			// Registration precedes upload. Protect even unpublished and deleting
			// records; their own collector owns recovery and capacity accounting.
			if (
				(
					await transaction.query("SELECT 1 FROM lexcerta.source_objects WHERE object_key = $1", [
						object.key,
					])
				).rowCount !== 0
			)
				return false;
			await transaction.query(
				"INSERT INTO lexcerta.orphan_object_deletions(object_key, generation) VALUES ($1,$2) ON CONFLICT DO NOTHING",
				[object.key, object.generation],
			);
			return true;
		});
	}
}

function compareObjectVersions(
	left: Pick<ListedSourceObject, "key" | "generation">,
	right: Pick<ListedSourceObject, "key" | "generation">,
): number {
	const keys = Buffer.compare(Buffer.from(left.key, "utf8"), Buffer.from(right.key, "utf8"));
	if (keys !== 0) return keys;
	const generations = BigInt(left.generation) - BigInt(right.generation);
	return generations === 0n ? 0 : generations < 0n ? -1 : 1;
}

function cleanupDeadline(budgetMs: number): number {
	if (!Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > 45_000)
		throw new RangeError("invalid cleanup budget");
	// Each in-flight GCS operation has a five-second timeout; the budget bounds
	// dispatch, and a claimed but undispatched row remains eligible for retry.
	return performance.now() + budgetMs;
}

function parsed(value: unknown): StoredState | null {
	return value === null || value === undefined
		? null
		: parseOpinionSourceState({ state_json: JSON.stringify(value) });
}
function requireState(state: OpinionSourceCacheState): StoredState {
	if (state.kind === "empty") throw new SourceObjectIntegrityError();
	return parseOpinionSourceState({ state_json: JSON.stringify(state) });
}
async function lockOpinion(transaction: PgTransaction, id: number): Promise<OpinionRow> {
	const row = (
		await transaction.query<OpinionRow>(
			"SELECT state, epoch, owner_token, lease_expires_at, body_key, removed_at FROM lexcerta.opinion_sources WHERE opinion_id = $1 FOR UPDATE",
			[id],
		)
	).rows[0];
	if (row === undefined) throw new SourceObjectIntegrityError();
	return row;
}
async function lockCapacity(transaction: PgTransaction): Promise<Capacity> {
	const row = (
		await transaction.query<Capacity>(
			"SELECT max_opinions, max_bytes FROM lexcerta.cache_capacity WHERE singleton = true FOR UPDATE",
		)
	).rows[0];
	if (row === undefined) throw new SourceObjectIntegrityError();
	return row;
}
async function objectRow(transaction: PgTransaction, key: string): Promise<ObjectRow | undefined> {
	return (
		await transaction.query<ObjectRow>(
			"SELECT * FROM lexcerta.source_objects WHERE object_key = $1",
			[key],
		)
	).rows[0];
}
function owns(row: OpinionRow, owner: string, now: Date): boolean {
	return (
		row.removed_at === null &&
		row.owner_token === owner &&
		row.lease_expires_at !== null &&
		row.lease_expires_at > now
	);
}
function metadataFor(row: ObjectRow, provenance: OpinionSourceProvenance): SourceObjectMetadata {
	return {
		contentHash: row.content_hash,
		opinionId: String(provenance.opinionId),
		clusterId: String(provenance.clusterId),
		canonicalUrl: provenance.canonicalUrl,
		epoch: row.epoch,
		representation: row.representation,
		acquiredAt: row.acquired_at.toISOString(),
		expiresAt: row.expires_at.toISOString(),
	};
}
function verifyObject(
	object: SourceObjectVersion,
	row: ObjectRow,
	provenance: OpinionSourceProvenance,
) {
	if (
		(row.generation !== null && row.generation !== object.generation) ||
		object.bytes.byteLength !== row.byte_size ||
		sourceHash(object.bytes) !== row.content_hash ||
		!sameMetadata(object.metadata, metadataFor(row, provenance))
	)
		throw new SourceObjectIntegrityError();
}

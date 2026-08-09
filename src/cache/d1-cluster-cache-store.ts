import { z } from "zod";
import {
	CLUSTER_FETCH_LEASE_MS,
	DEFAULT_CLUSTER_FRESHNESS_MS,
	MAX_OPINIONS_PER_CLUSTER,
} from "./cluster-cache-store.js";
import type {
	CachedCluster,
	ClusterCacheStore,
	ClusterLeaseResult,
} from "./cluster-cache-store.js";

const clusterIdSchema = z.number().int().positive();
const publicUrlSchema = z.string().url().max(2_048).refine(isPublicOpinionUrl);
const opinionSchema = z
	.object({ id: clusterIdSchema, url: z.string().url().max(2_048) })
	.strict()
	.refine((value) => isOpinionUrl(value.url, value.id));
const opinionsSchema = z
	.array(opinionSchema)
	.min(0)
	.max(MAX_OPINIONS_PER_CLUSTER)
	.superRefine((items, context) => {
		if (new Set(items.map((item) => item.id)).size !== items.length)
			context.addIssue({ code: "custom", message: "Duplicate opinion id" });
		if (new Set(items.map((item) => item.url)).size !== items.length)
			context.addIssue({ code: "custom", message: "Duplicate opinion URL" });
	});
const rowSchema = z.object({
	cluster_id: clusterIdSchema,
	canonical_url: publicUrlSchema,
	opinions_json: z.string().min(1).max(262_144),
	retrieved_at: z.string().datetime({ offset: true }),
	fresh_until: z.string().datetime({ offset: true }),
});
const fillSchema = z.object({
	clusterId: clusterIdSchema,
	canonicalUrl: publicUrlSchema,
	opinions: opinionsSchema,
});
const leaseSchema = z.object({ expires_at: z.string().datetime({ offset: true }) });

export function createD1ClusterCacheStore(database: D1Database): ClusterCacheStore {
	return {
		readCluster: async ({ clusterId }) => read(database, clusterId),
		acquireClusterLease: async (input) => acquire(database, input),
		fillClusterLease: async (input) => fill(database, input),
		releaseClusterLease: async ({ clusterId, ownerToken }) =>
			release(database, clusterId, ownerToken),
	};
}

async function read(database: D1Database, clusterId: number): Promise<CachedCluster | null> {
	const row = await database
		.prepare(
			"SELECT cluster_id, canonical_url, opinions_json, retrieved_at, fresh_until FROM cluster_source_metadata WHERE cluster_id = ?1",
		)
		.bind(clusterId)
		.first<unknown>();
	if (row === null) return null;
	const metadata = rowSchema.safeParse(row);
	if (!metadata.success) throw new ClusterSourceCacheCorruptError();
	const opinions = parseOpinions(metadata.data.opinions_json);
	return {
		clusterId: metadata.data.cluster_id,
		canonicalUrl: metadata.data.canonical_url,
		opinions,
		retrievedAt: new Date(metadata.data.retrieved_at),
		freshUntil: new Date(metadata.data.fresh_until),
	};
}

async function acquire(
	database: D1Database,
	input: { readonly clusterId: number; readonly ownerToken: string; readonly now: Date },
): Promise<ClusterLeaseResult> {
	const now = input.now.toISOString();
	const expiresAt = new Date(input.now.getTime() + CLUSTER_FETCH_LEASE_MS).toISOString();
	const result = await database
		.prepare(
			"INSERT INTO cluster_fetch_leases (cluster_id, owner_token, expires_at) VALUES (?1, ?2, ?3) ON CONFLICT(cluster_id) DO UPDATE SET owner_token = excluded.owner_token, expires_at = excluded.expires_at WHERE cluster_fetch_leases.expires_at <= ?4",
		)
		.bind(input.clusterId, input.ownerToken, expiresAt, now)
		.run();
	if (changes(result) === 1) return { kind: "acquired", expiresAt };
	const held = await database
		.prepare("SELECT expires_at FROM cluster_fetch_leases WHERE cluster_id = ?1")
		.bind(input.clusterId)
		.first<unknown>();
	if (held === null) return acquire(database, input);
	const parsed = leaseSchema.safeParse(held);
	if (!parsed.success) throw new ClusterSourceCacheCorruptError();
	return { kind: "held", expiresAt: parsed.data.expires_at };
}

async function fill(
	database: D1Database,
	input: {
		readonly ownerToken: string;
		readonly now: Date;
		readonly cluster: Omit<CachedCluster, "retrievedAt" | "freshUntil">;
	},
): Promise<
	| { readonly kind: "stored"; readonly cluster: CachedCluster }
	| { readonly kind: "lease_unavailable" }
> {
	const cluster = fillSchema.safeParse(input.cluster);
	if (!cluster.success) throw new ClusterSourceCacheCorruptError();
	const opinions = cluster.data.opinions;
	const now = input.now.toISOString();
	const freshUntil = new Date(input.now.getTime() + DEFAULT_CLUSTER_FRESHNESS_MS);
	const saved = JSON.stringify(opinions);
	const results = await database.batch([
		database
			.prepare(
				"INSERT INTO cluster_source_metadata (cluster_id, canonical_url, opinions_json, retrieved_at, fresh_until) SELECT ?1, ?2, ?3, ?4, ?5 WHERE EXISTS (SELECT 1 FROM cluster_fetch_leases WHERE cluster_id = ?1 AND owner_token = ?6 AND expires_at > ?4) ON CONFLICT(cluster_id) DO UPDATE SET canonical_url = excluded.canonical_url, opinions_json = excluded.opinions_json, retrieved_at = excluded.retrieved_at, fresh_until = excluded.fresh_until WHERE EXISTS (SELECT 1 FROM cluster_fetch_leases WHERE cluster_id = ?1 AND owner_token = ?6 AND expires_at > ?4)",
			)
			.bind(
				cluster.data.clusterId,
				cluster.data.canonicalUrl,
				saved,
				now,
				freshUntil.toISOString(),
				input.ownerToken,
			),
		database
			.prepare(
				"DELETE FROM cluster_fetch_leases WHERE cluster_id = ?1 AND owner_token = ?2 AND expires_at > ?3",
			)
			.bind(cluster.data.clusterId, input.ownerToken, now),
	]);
	return changes(results[0]) === 1
		? { kind: "stored", cluster: { ...cluster.data, retrievedAt: input.now, freshUntil } }
		: { kind: "lease_unavailable" };
}

async function release(
	database: D1Database,
	clusterId: number,
	ownerToken: string,
): Promise<{ readonly kind: "released" } | { readonly kind: "lease_unavailable" }> {
	const result = await database
		.prepare("DELETE FROM cluster_fetch_leases WHERE cluster_id = ?1 AND owner_token = ?2")
		.bind(clusterId, ownerToken)
		.run();
	return changes(result) === 1 ? { kind: "released" } : { kind: "lease_unavailable" };
}

function parseOpinions(value: string): z.infer<typeof opinionsSchema> {
	try {
		const parsed = opinionsSchema.safeParse(JSON.parse(value));
		if (parsed.success) return parsed.data;
	} catch (error) {
		if (!(error instanceof SyntaxError)) throw error;
	}
	throw new ClusterSourceCacheCorruptError();
}
function isPublicOpinionUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			url.hostname === "www.courtlistener.com" &&
			/^\/opinion\/\d+\/[^/]+\/$/.test(url.pathname) &&
			url.search === "" &&
			url.hash === ""
		);
	} catch (error) {
		if (error instanceof TypeError) return false;
		throw error;
	}
}
function isOpinionUrl(value: string, id: number): boolean {
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			url.hostname === "www.courtlistener.com" &&
			url.pathname === `/api/rest/v4/opinions/${id}/` &&
			url.search === "" &&
			url.hash === ""
		);
	} catch (error) {
		if (error instanceof TypeError) return false;
		throw error;
	}
}
function changes(result: D1Result<unknown> | undefined): number {
	return typeof result?.meta.changes === "number" ? result.meta.changes : 0;
}
export class ClusterSourceCacheCorruptError extends Error {
	readonly name = "ClusterSourceCacheCorruptError";
	constructor() {
		super("cluster source cache is corrupt");
	}
}

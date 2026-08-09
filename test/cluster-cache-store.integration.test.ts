import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import migration from "../migrations/0005_opinion_source_cache.sql?raw";
import { MAX_OPINIONS_PER_CLUSTER } from "../src/cache/cluster-cache-store.js";
import {
	ClusterSourceCacheCorruptError,
	createD1ClusterCacheStore,
} from "../src/cache/d1-cluster-cache-store.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");

async function reset(): Promise<void> {
	await env.DB.prepare("DROP TABLE IF EXISTS cluster_fetch_leases").run();
	await env.DB.prepare("DROP TABLE IF EXISTS cluster_source_metadata").run();
	for (const statement of migration
		.split(";")
		.map((value) => value.trim())
		.filter(Boolean)) {
		await env.DB.prepare(statement).run();
	}
}

describe("D1 cluster cache store", () => {
	beforeEach(reset);

	it("stores a bounded cluster snapshot through an owner lease and recovers it without R2", async () => {
		// Given: a cluster fetch owner and its complete required opinion identifiers.
		const store = createD1ClusterCacheStore(env.DB);
		await store.acquireClusterLease({ clusterId: 123, ownerToken: "owner-a", now: NOW });

		// When: a waiter checks at one millisecond before and exactly at expiry.
		const takeoverAt = new Date(NOW.getTime() + 10_000);
		await expect(
			store.acquireClusterLease({
				clusterId: 123,
				ownerToken: "owner-b",
				now: new Date(takeoverAt.getTime() - 1),
			}),
		).resolves.toMatchObject({ kind: "held" });
		await store.acquireClusterLease({ clusterId: 123, ownerToken: "owner-b", now: takeoverAt });
		const saved = await store.fillClusterLease({
			ownerToken: "owner-b",
			now: takeoverAt,
			cluster: {
				clusterId: 123,
				canonicalUrl: "https://www.courtlistener.com/opinion/123/example/",
				opinions: [{ id: 456, url: "https://www.courtlistener.com/api/rest/v4/opinions/456/" }],
			},
		});

		// Then: a fresh durable snapshot is returned with the exact opinion id/url list.
		expect(saved).toMatchObject({ kind: "stored" });
		await expect(store.readCluster({ clusterId: 123 })).resolves.toMatchObject({
			opinions: [{ id: 456, url: "https://www.courtlistener.com/api/rest/v4/opinions/456/" }],
		});
	});

	it("fails closed for a corrupt persisted opinion list", async () => {
		// Given: D1 metadata whose required opinion list is malformed.
		await env.DB.prepare(
			"INSERT INTO cluster_source_metadata (cluster_id, canonical_url, opinions_json, retrieved_at, fresh_until) VALUES (?1, ?2, ?3, ?4, ?5)",
		)
			.bind(
				123,
				"https://www.courtlistener.com/opinion/123/example/",
				"[{}]",
				NOW.toISOString(),
				NOW.toISOString(),
			)
			.run();

		// When: the store loads the corrupt snapshot.
		const read = createD1ClusterCacheStore(env.DB).readCluster({ clusterId: 123 });

		// Then: no partial cluster can reach quote verification.
		await expect(read).rejects.toEqual(new ClusterSourceCacheCorruptError());
	});

	it("stores a trusted empty cluster as a complete zero-opinion snapshot", async () => {
		// Given: a trusted cluster that CourtListener reports with no sub-opinions.
		const store = createD1ClusterCacheStore(env.DB);
		await store.acquireClusterLease({ clusterId: 123, ownerToken: "owner-a", now: NOW });

		// When: the cluster snapshot crosses the durable cache boundary.
		await expect(
			store.fillClusterLease({
				ownerToken: "owner-a",
				now: NOW,
				cluster: {
					clusterId: 123,
					canonicalUrl: "https://www.courtlistener.com/opinion/123/example/",
					opinions: [],
				},
			}),
		).resolves.toMatchObject({ kind: "stored", cluster: { opinions: [] } });

		// Then: the complete empty snapshot is recoverable without source text or legal text.
		await expect(store.readCluster({ clusterId: 123 })).resolves.toMatchObject({ opinions: [] });
	});

	it.each([
		[
			"untrusted public host",
			"https://example.invalid/opinion/123/example/",
			[{ id: 456, url: "https://www.courtlistener.com/api/rest/v4/opinions/456/" }],
		],
		[
			"opinion URL/id mismatch",
			"https://www.courtlistener.com/opinion/123/example/",
			[{ id: 456, url: "https://www.courtlistener.com/api/rest/v4/opinions/999/" }],
		],
		[
			"duplicate opinion identity",
			"https://www.courtlistener.com/opinion/123/example/",
			[
				{ id: 456, url: "https://www.courtlistener.com/api/rest/v4/opinions/456/" },
				{ id: 456, url: "https://www.courtlistener.com/api/rest/v4/opinions/456/" },
			],
		],
	])("rejects %s at the durable fill boundary", async (_label, canonicalUrl, opinions) => {
		const store = createD1ClusterCacheStore(env.DB);
		await store.acquireClusterLease({ clusterId: 123, ownerToken: "owner-a", now: NOW });
		await expect(
			store.fillClusterLease({
				ownerToken: "owner-a",
				now: NOW,
				cluster: { clusterId: 123, canonicalUrl, opinions },
			}),
		).rejects.toEqual(new ClusterSourceCacheCorruptError());
	});

	it("stores the maximum accepted list and rejects one additional opinion before D1 fill", async () => {
		const opinions = Array.from({ length: MAX_OPINIONS_PER_CLUSTER }, (_, index) => {
			const id = index + 1;
			return { id, url: `https://www.courtlistener.com/api/rest/v4/opinions/${id}/` };
		});
		const store = createD1ClusterCacheStore(env.DB);
		await store.acquireClusterLease({ clusterId: 123, ownerToken: "owner-a", now: NOW });
		await expect(
			store.fillClusterLease({
				ownerToken: "owner-a",
				now: NOW,
				cluster: {
					clusterId: 123,
					canonicalUrl: "https://www.courtlistener.com/opinion/123/example/",
					opinions,
				},
			}),
		).resolves.toMatchObject({ kind: "stored" });
		await expect(store.readCluster({ clusterId: 123 })).resolves.toMatchObject({
			opinions: expect.arrayContaining([
				{ id: 100, url: "https://www.courtlistener.com/api/rest/v4/opinions/100/" },
			]),
		});

		await store.acquireClusterLease({ clusterId: 124, ownerToken: "owner-b", now: NOW });
		await expect(
			store.fillClusterLease({
				ownerToken: "owner-b",
				now: NOW,
				cluster: {
					clusterId: 124,
					canonicalUrl: "https://www.courtlistener.com/opinion/124/example/",
					opinions: [
						...opinions,
						{ id: 101, url: "https://www.courtlistener.com/api/rest/v4/opinions/101/" },
					],
				},
			}),
		).rejects.toEqual(new ClusterSourceCacheCorruptError());
	});
});

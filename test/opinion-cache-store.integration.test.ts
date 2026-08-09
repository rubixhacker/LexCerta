import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import migration from "../migrations/0005_opinion_source_cache.sql?raw";
import {
	createD1R2OpinionCacheStore,
	OpinionSourceCacheCorruptError,
} from "../src/cache/d1-r2-opinion-cache-store.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const FRESH_UNTIL = new Date("2026-09-08T12:00:00.000Z");
const SOURCE_TEXT = "OPINION_SOURCE_SENTINEL &amp; full selected representation";

async function reset(): Promise<void> {
	await env.DB.prepare("DROP TABLE IF EXISTS opinion_fetch_leases").run();
	await env.DB.prepare("DROP TABLE IF EXISTS opinion_source_metadata").run();
	for (const statement of migration
		.split(";")
		.map((value) => value.trim())
		.filter(Boolean)) {
		await env.DB.prepare(statement).run();
	}
}

describe("D1/R2 opinion cache store", () => {
	beforeEach(reset);

	it("stores the selected raw representation only in R2 after its owner acquires the lease", async () => {
		// Given: an empty durable cache and a successful selected HTML representation.
		const store = createD1R2OpinionCacheStore({ database: env.DB, opinions: env.OPINIONS });
		const opinion = {
			opinionId: 456,
			clusterId: 123,
			canonicalUrl: "https://www.courtlistener.com/opinion/123/example/",
			representation: "html_with_citations" as const,
			retrievedAt: NOW,
			freshUntil: FRESH_UNTIL,
			sourceText: SOURCE_TEXT,
		};
		await expect(
			store.acquireLease({ opinionId: opinion.opinionId, ownerToken: "owner-a", now: NOW }),
		).resolves.toEqual({ kind: "acquired", expiresAt: "2026-08-09T12:00:10.000Z" });

		// When: the active owner fills the opinion cache.
		const filled = await store.fillLease({ ownerToken: "owner-a", now: NOW, opinion });

		// Then: reads recover the raw source from R2 while D1 exposes only bounded metadata/reference.
		expect(filled).toEqual({ kind: "stored", opinion });
		await expect(store.read({ opinionId: opinion.opinionId })).resolves.toEqual(opinion);
		const metadata = await env.DB.prepare(
			"SELECT opinion_id, cluster_id, canonical_url, representation, retrieved_at, fresh_until, content_sha256, object_key FROM opinion_source_metadata WHERE opinion_id = ?1",
		)
			.bind(opinion.opinionId)
			.first<{
				readonly opinion_id: number;
				readonly cluster_id: number;
				readonly canonical_url: string;
				readonly representation: string;
				readonly retrieved_at: string;
				readonly fresh_until: string;
				readonly content_sha256: string;
				readonly object_key: string;
			}>();
		expect(metadata).toEqual({
			opinion_id: 456,
			cluster_id: 123,
			canonical_url: "https://www.courtlistener.com/opinion/123/example/",
			representation: "html_with_citations",
			retrieved_at: NOW.toISOString(),
			fresh_until: FRESH_UNTIL.toISOString(),
			content_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
			object_key: expect.any(String),
		});
		expect(JSON.stringify(metadata)).not.toContain(SOURCE_TEXT);
		expect(metadata?.object_key).toBe(`opinions/456/${metadata?.content_sha256}`);
		const object = await env.OPINIONS.get(metadata?.object_key ?? "");
		await expect(object?.text()).resolves.toBe(SOURCE_TEXT);
	});

	it("rejects a tampered R2 object whose body no longer matches D1 integrity metadata", async () => {
		// Given: an opinion filled through the active lease owner.
		const store = createD1R2OpinionCacheStore({ database: env.DB, opinions: env.OPINIONS });
		const opinion = {
			opinionId: 456,
			clusterId: 123,
			canonicalUrl: "https://www.courtlistener.com/opinion/123/example/",
			representation: "html" as const,
			retrievedAt: NOW,
			freshUntil: FRESH_UNTIL,
			sourceText: SOURCE_TEXT,
		};
		await store.acquireLease({ opinionId: opinion.opinionId, ownerToken: "owner-a", now: NOW });
		await store.fillLease({ ownerToken: "owner-a", now: NOW, opinion });
		const metadata = await env.DB.prepare(
			"SELECT object_key FROM opinion_source_metadata WHERE opinion_id = ?1",
		)
			.bind(opinion.opinionId)
			.first<{ readonly object_key: string }>();
		await env.OPINIONS.put(metadata?.object_key ?? "", "tampered source");

		// When: the public cache store reads the altered R2 object.
		const read = store.read({ opinionId: opinion.opinionId });

		// Then: integrity mismatch becomes a cache error rather than untrusted source content.
		await expect(read).rejects.toEqual(new OpinionSourceCacheCorruptError());
	});

	it("coalesces simultaneous misses and prevents a former owner from filling after takeover", async () => {
		// Given: sixteen callers contend for one CourtListener opinion ID.
		const store = createD1R2OpinionCacheStore({ database: env.DB, opinions: env.OPINIONS });
		const results = await Promise.all(
			Array.from({ length: 16 }, (_, index) =>
				store.acquireLease({ opinionId: 456, ownerToken: `owner-${index}`, now: NOW }),
			),
		);
		const ownerIndex = results.findIndex((result) => result.kind === "acquired");
		const ownerToken = `owner-${ownerIndex}`;
		expect(results.filter((result) => result.kind === "acquired")).toHaveLength(1);
		expect(results.filter((result) => result.kind === "held")).toHaveLength(15);

		// When: a waiter observes the lease immediately before and at expiry.
		const takeoverAt = new Date(NOW.getTime() + 10_000);
		await expect(
			store.acquireLease({
				opinionId: 456,
				ownerToken: "owner-b",
				now: new Date(takeoverAt.getTime() - 1),
			}),
		).resolves.toEqual({ kind: "held", expiresAt: "2026-08-09T12:00:10.000Z" });
		await expect(
			store.acquireLease({ opinionId: 456, ownerToken: "owner-b", now: takeoverAt }),
		).resolves.toEqual({ kind: "acquired", expiresAt: "2026-08-09T12:00:20.000Z" });
		const late = await store.fillLease({
			ownerToken,
			now: takeoverAt,
			opinion: {
				opinionId: 456,
				clusterId: 123,
				canonicalUrl: "https://www.courtlistener.com/opinion/123/example/",
				representation: "plain_text",
				retrievedAt: NOW,
				freshUntil: FRESH_UNTIL,
				sourceText: "former owner source",
			},
		});

		// Then: only the takeover owner can publish the cache reference and R2 body.
		expect(late).toEqual({ kind: "lease_unavailable" });
		await expect(
			store.fillLease({
				ownerToken: "owner-b",
				now: takeoverAt,
				opinion: {
					opinionId: 456,
					clusterId: 123,
					canonicalUrl: "https://www.courtlistener.com/opinion/123/example/",
					representation: "plain_text",
					retrievedAt: takeoverAt,
					freshUntil: FRESH_UNTIL,
					sourceText: "takeover owner source",
				},
			}),
		).resolves.toMatchObject({ kind: "stored" });
		await expect(store.read({ opinionId: 456 })).resolves.toMatchObject({
			sourceText: "takeover owner source",
		});
	});

	it("rejects metadata corruption without exposing untrusted cache values", async () => {
		// Given: a D1 metadata row with an invalid canonical URL.
		await env.DB.prepare(
			"INSERT INTO opinion_source_metadata (opinion_id, cluster_id, canonical_url, representation, retrieved_at, fresh_until, content_sha256, object_key) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
		)
			.bind(
				456,
				123,
				"https://example.invalid/opinion/123/example/",
				"html",
				NOW.toISOString(),
				FRESH_UNTIL.toISOString(),
				"0".repeat(64),
				"opinions/456/untrusted",
			)
			.run();

		// When: the cache is read through its public store boundary.
		const read = createD1R2OpinionCacheStore({ database: env.DB, opinions: env.OPINIONS }).read({
			opinionId: 456,
		});

		// Then: the corrupt data becomes a stable adapter error instead of provenance.
		await expect(read).rejects.toEqual(new OpinionSourceCacheCorruptError());
	});

	it("treats metadata that references a missing R2 object as a cache miss", async () => {
		// Given: bounded D1 metadata whose referenced R2 object is absent.
		await env.DB.prepare(
			"INSERT INTO opinion_source_metadata (opinion_id, cluster_id, canonical_url, representation, retrieved_at, fresh_until, content_sha256, object_key) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
		)
			.bind(
				456,
				123,
				"https://www.courtlistener.com/opinion/123/example/",
				"plain_text",
				NOW.toISOString(),
				FRESH_UNTIL.toISOString(),
				"0".repeat(64),
				"opinions/456/missing",
			)
			.run();

		// When: the store loads that durable reference.
		const found = await createD1R2OpinionCacheStore({
			database: env.DB,
			opinions: env.OPINIONS,
		}).read({ opinionId: 456 });

		// Then: no unverified source representation reaches the caller.
		expect(found).toBeNull();
	});
});

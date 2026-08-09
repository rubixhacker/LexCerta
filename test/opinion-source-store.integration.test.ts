import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import migration from "../migrations/0005_opinion_source_cache.sql?raw";
import {
	OpinionSourceCacheCorruptError,
	createD1R2OpinionSourceStore,
} from "../src/cache/d1-r2-opinion-source-store.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const PROVENANCE = {
	canonicalUrl: "https://www.courtlistener.com/opinion/123/example/",
	clusterId: 123,
	opinionId: 456,
} as const;
const SOURCE = "<p>Equal justice under law.</p>";

async function reset(): Promise<void> {
	await env.OPINION_CACHE.delete((await env.OPINION_CACHE.list()).objects.map(({ key }) => key));
	for (const table of [
		"opinion_source_fetch_leases",
		"opinion_source_object_versions",
		"opinion_source_states",
	]) {
		await env.DB.prepare(`DROP TABLE IF EXISTS ${table}`).run();
	}
	for (const statement of migration
		.split(";")
		.map((value) => value.trim())
		.filter(Boolean)) {
		await env.DB.prepare(statement).run();
	}
}

async function filledStore() {
	const store = createD1R2OpinionSourceStore({
		bucket: env.OPINION_CACHE,
		clock: { now: () => NOW },
		database: env.DB,
	});
	await store.acquireLease({ now: NOW, opinionId: PROVENANCE.opinionId, ownerToken: "owner-a" });
	await store.fillLease({
		now: NOW,
		ownerToken: "owner-a",
		observation: {
			kind: "positive",
			provenance: PROVENANCE,
			representation: "html_with_citations",
			sourceText: SOURCE,
		},
	});
	return store;
}

describe("D1 and R2 opinion source store", () => {
	beforeEach(reset);

	it("stores raw selected source only in R2 and reuses it from a separate adapter", async () => {
		// Given: one active D1 fill lease and an exact selected opinion representation.
		const store = await filledStore();

		// When: a new adapter instance reads the same trusted opinion provenance.
		const reused = await createD1R2OpinionSourceStore({
			bucket: env.OPINION_CACHE,
			database: env.DB,
		}).read({ provenance: PROVENANCE });

		// Then: R2 supplies the canonical raw representation while D1 retains metadata only.
		expect(reused).toMatchObject({
			kind: "positive",
			sourceText: SOURCE,
			state: { kind: "positive", positive: { provenance: PROVENANCE } },
		});
		const row = await env.DB.prepare(
			"SELECT state_json FROM opinion_source_states WHERE opinion_id = ?1",
		)
			.bind(PROVENANCE.opinionId)
			.first<{ readonly state_json: string }>();
		expect(row?.state_json).not.toContain(SOURCE);
		const versions = await env.DB.prepare(
			"SELECT metadata_json FROM opinion_source_object_versions WHERE opinion_id = ?1",
		)
			.bind(PROVENANCE.opinionId)
			.all<{ readonly metadata_json: string }>();
		expect(versions.results[0]?.metadata_json).not.toContain(SOURCE);
		expect(await env.OPINION_CACHE.list()).toMatchObject({
			objects: [{ key: expect.stringMatching(/^opinions\/456\/[0-9a-f]{64}\/[0-9a-f]{64}$/) }],
		});
		await expect(store.read({ provenance: PROVENANCE })).resolves.toMatchObject({
			kind: "positive",
		});
	});

	it("fails closed when the R2 object does not match D1's content hash", async () => {
		// Given: D1 points at an R2 object whose bytes are later replaced.
		await filledStore();
		const key = (await env.OPINION_CACHE.list()).objects[0]?.key;
		if (key === undefined) throw new TypeError("expected opinion R2 object");
		await env.OPINION_CACHE.put(key, "tampered");

		// When: a separate adapter attempts to reuse that opinion evidence.
		const read = createD1R2OpinionSourceStore({ bucket: env.OPINION_CACHE, database: env.DB }).read(
			{
				provenance: PROVENANCE,
			},
		);

		// Then: corrupt cached source text cannot become evidence.
		await expect(read).rejects.toBeInstanceOf(OpinionSourceCacheCorruptError);
	});

	it("does not reuse a tampered existing R2 version during a same-hash revalidation", async () => {
		// Given: D1 version metadata whose existing R2 object is replaced after the first fill.
		const store = await filledStore();
		const key = (await env.OPINION_CACHE.list()).objects[0]?.key;
		if (key === undefined) throw new TypeError("expected opinion R2 object");
		await env.OPINION_CACHE.put(key, "tampered");
		const revalidatedAt = new Date(NOW.getTime() + 1_000);
		await store.acquireLease({
			now: revalidatedAt,
			opinionId: PROVENANCE.opinionId,
			ownerToken: "revalidator",
		});

		// When: a fresh upstream source has the same hash as the recorded content version.
		const fill = store.fillLease({
			now: revalidatedAt,
			ownerToken: "revalidator",
			observation: {
				kind: "positive",
				provenance: PROVENANCE,
				representation: "html_with_citations",
				sourceText: SOURCE,
			},
		});

		// Then: corrupt durable bytes fail closed rather than being silently republished.
		await expect(fill).rejects.toBeInstanceOf(OpinionSourceCacheCorruptError);
	});

	it("refreshes a stale same-byte representation without duplicating R2", async () => {
		// Given: a stale HTML version whose later selected representation has identical source bytes.
		const staleAt = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1_000 - 1);
		let commitNow = staleAt;
		const store = createD1R2OpinionSourceStore({
			bucket: env.OPINION_CACHE,
			clock: { now: () => commitNow },
			database: env.DB,
		});
		await store.acquireLease({
			now: staleAt,
			opinionId: PROVENANCE.opinionId,
			ownerToken: "stale-owner",
		});
		await store.fillLease({
			now: staleAt,
			ownerToken: "stale-owner",
			observation: {
				kind: "positive",
				provenance: PROVENANCE,
				representation: "html",
				sourceText: SOURCE,
			},
		});
		commitNow = NOW;
		await store.acquireLease({
			now: NOW,
			opinionId: PROVENANCE.opinionId,
			ownerToken: "fresh-owner",
		});

		// When: revalidation selects html_with_citations without changing canonical bytes.
		const fresh = store.fillLease({
			now: NOW,
			ownerToken: "fresh-owner",
			observation: {
				kind: "positive",
				provenance: PROVENANCE,
				representation: "html_with_citations",
				sourceText: SOURCE,
			},
		});

		// Then: D1 retains two representation records while R2 retains one verified content object.
		await expect(fresh).resolves.toMatchObject({
			kind: "stored",
			state: { kind: "positive", positive: { representation: "html_with_citations" } },
		});
		const versions = await env.DB.prepare(
			"SELECT metadata_json, object_key FROM opinion_source_object_versions WHERE opinion_id = ?1",
		)
			.bind(PROVENANCE.opinionId)
			.all<{ readonly metadata_json: string; readonly object_key: string }>();
		expect(versions.results).toHaveLength(2);
		expect(versions.results.map(({ metadata_json }) => metadata_json)).toEqual(
			expect.arrayContaining([
				expect.stringContaining('"representation":"html"'),
				expect.stringContaining('"representation":"html_with_citations"'),
			]),
		);
		expect(new Set(versions.results.map(({ object_key }) => object_key))).toHaveLength(1);
		expect((await env.OPINION_CACHE.list()).objects).toHaveLength(1);
	});

	it("keeps old content versions after a later active positive fill", async () => {
		// Given: a first durable selected representation.
		const store = await filledStore();
		await store.acquireLease({
			now: new Date(NOW.getTime() + 1_000),
			opinionId: PROVENANCE.opinionId,
			ownerToken: "owner-b",
		});

		// When: the next active owner observes changed canonical source text.
		await store.fillLease({
			now: new Date(NOW.getTime() + 1_000),
			ownerToken: "owner-b",
			observation: {
				kind: "positive",
				provenance: PROVENANCE,
				representation: "html_with_citations",
				sourceText: "<p>Equal protection under law.</p>",
			},
		});

		// Then: the active D1 state advances while R2/D1 version history retains both hashes.
		const versions = await env.DB.prepare(
			"SELECT content_sha256_hex FROM opinion_source_object_versions WHERE opinion_id = ?1",
		)
			.bind(PROVENANCE.opinionId)
			.all<{ readonly content_sha256_hex: string }>();
		expect(versions.results).toHaveLength(2);
		expect((await env.OPINION_CACHE.list()).objects).toHaveLength(2);
	});

	it("rejects non-hex content-version rows before they can reference R2", async () => {
		// Given: a version metadata insertion with a non-hex character after a valid first byte.
		const invalidHash = `${"a".repeat(63)}g`;

		// When: D1 applies the committed content-hash constraint.
		const insert = env.DB.prepare(
			"INSERT INTO opinion_source_object_versions (opinion_id, content_sha256_hex, object_key, metadata_json, stored_at) VALUES (?1, ?2, ?3, ?4, ?5)",
		)
			.bind(
				PROVENANCE.opinionId,
				invalidHash,
				"opinions/456/sha256-invalid",
				"{}",
				NOW.toISOString(),
			)
			.run();

		// Then: malformed version metadata is rejected by real workerd D1.
		await expect(insert).rejects.toThrow();
	});
});

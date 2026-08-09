import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import migration from "../migrations/0005_opinion_source_cache.sql?raw";
import {
	OpinionSourceCacheCorruptError,
	createD1R2OpinionSourceStore,
} from "../src/cache/d1-r2-opinion-source-store.js";
import { OPINION_SOURCE_FETCH_LEASE_MS } from "../src/cache/opinion-source-store.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const PROVENANCE = {
	canonicalUrl: "https://www.courtlistener.com/opinion/123/example/",
	clusterId: 123,
	opinionId: 456,
} as const;

function at(milliseconds: number): Date {
	return new Date(NOW.getTime() + milliseconds);
}

function positive(sourceText: string) {
	return {
		kind: "positive" as const,
		provenance: PROVENANCE,
		representation: "html" as const,
		sourceText,
	};
}

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

function store() {
	return createD1R2OpinionSourceStore({ bucket: env.OPINION_CACHE, database: env.DB });
}

describe("D1 and R2 opinion source leases", () => {
	beforeEach(reset);

	it("coalesces concurrent opinion misses into one ten-second durable owner", async () => {
		// Given: sixteen separate adapters seek the same missing opinion source.
		const stores = Array.from({ length: 16 }, store);

		// When: every adapter tries to become the fill owner at once.
		const results = await Promise.all(
			stores.map((item, index) =>
				item.acquireLease({
					now: NOW,
					opinionId: PROVENANCE.opinionId,
					ownerToken: `owner-${index}`,
				}),
			),
		);

		// Then: exactly one upstream fetch is avoidable and every waiter receives its deadline.
		expect(OPINION_SOURCE_FETCH_LEASE_MS).toBe(10_000);
		expect(results.filter((result) => result.kind === "acquired")).toHaveLength(1);
		expect(results.filter((result) => result.kind === "held")).toHaveLength(15);
	});

	it("does not let an expired former owner activate its uploaded object", async () => {
		// Given: an owner loses its lease at the exact expiration boundary.
		const first = store();
		const second = store();
		await first.acquireLease({ now: NOW, opinionId: PROVENANCE.opinionId, ownerToken: "first" });
		await second.acquireLease({
			now: at(OPINION_SOURCE_FETCH_LEASE_MS),
			opinionId: PROVENANCE.opinionId,
			ownerToken: "second",
		});

		// When: the late former owner writes while the successor owns the D1 lease.
		const late = await first.fillLease({
			now: at(OPINION_SOURCE_FETCH_LEASE_MS),
			ownerToken: "first",
			observation: positive("former owner source"),
		});

		// Then: only the successor can publish an active D1 reference or version-history row.
		expect(late).toEqual({ kind: "lease_unavailable" });
		expect(await first.read({ provenance: PROVENANCE })).toBeNull();
		expect((await env.OPINION_CACHE.list()).objects).toHaveLength(0);
		await second.fillLease({
			now: at(OPINION_SOURCE_FETCH_LEASE_MS),
			ownerToken: "second",
			observation: positive("successor source"),
		});
		await expect(second.read({ provenance: PROVENANCE })).resolves.toMatchObject({
			kind: "positive",
			sourceText: "successor source",
		});
		const versions = await env.DB.prepare(
			"SELECT metadata_json FROM opinion_source_object_versions WHERE opinion_id = ?1",
		)
			.bind(PROVENANCE.opinionId)
			.all<{ readonly metadata_json: string }>();
		expect(versions.results).toHaveLength(1);
		expect(versions.results[0]?.metadata_json).not.toContain("former owner source");
	});

	it("does not delete a same-content object already published by the winner", async () => {
		// Given: a former owner loses its lease and the successor publishes equal source bytes.
		const first = store();
		const second = store();
		await first.acquireLease({ now: NOW, opinionId: PROVENANCE.opinionId, ownerToken: "first" });
		await second.acquireLease({
			now: at(OPINION_SOURCE_FETCH_LEASE_MS),
			opinionId: PROVENANCE.opinionId,
			ownerToken: "second",
		});
		await second.fillLease({
			now: at(OPINION_SOURCE_FETCH_LEASE_MS),
			ownerToken: "second",
			observation: positive("shared source"),
		});

		// When: the former owner completes the same content after publication.
		const late = await first.fillLease({
			now: at(OPINION_SOURCE_FETCH_LEASE_MS),
			ownerToken: "first",
			observation: positive("shared source"),
		});

		// Then: the late completion cannot remove the winner's durable R2 evidence.
		expect(late).toEqual({ kind: "lease_unavailable" });
		await expect(second.read({ provenance: PROVENANCE })).resolves.toMatchObject({
			kind: "positive",
			sourceText: "shared source",
		});
		expect((await env.OPINION_CACHE.list()).objects).toHaveLength(1);
	});

	it("rejects D1 metadata that does not bind to the requested provenance", async () => {
		// Given: a cache row whose trusted host is paired with a different cluster identity.
		await env.DB.prepare(
			"INSERT INTO opinion_source_states (opinion_id, state_json, updated_at) VALUES (?1, ?2, ?3)",
		)
			.bind(
				PROVENANCE.opinionId,
				JSON.stringify({
					kind: "negative",
					negative: {
						kind: "negative",
						provenance: { ...PROVENANCE, clusterId: 999 },
						retrievedAt: NOW,
					},
					superseded: null,
				}),
				NOW.toISOString(),
			)
			.run();

		// When: the adapter reads it under the expected citation-cluster provenance.
		const read = store().read({ provenance: PROVENANCE });

		// Then: mismatched source identity fails closed instead of supplying cached evidence.
		await expect(read).rejects.toBeInstanceOf(OpinionSourceCacheCorruptError);
	});

	it("rejects D1 state that smuggles opinion text into metadata", async () => {
		// Given: an otherwise valid negative metadata state with an injected source-text field.
		await env.DB.prepare(
			"INSERT INTO opinion_source_states (opinion_id, state_json, updated_at) VALUES (?1, ?2, ?3)",
		)
			.bind(
				PROVENANCE.opinionId,
				JSON.stringify({
					kind: "negative",
					negative: {
						kind: "negative",
						provenance: PROVENANCE,
						retrievedAt: NOW,
						sourceText: "injected opinion text",
					},
					superseded: null,
				}),
				NOW.toISOString(),
			)
			.run();

		// When: the store parses the authoritative D1 row.
		const read = store().read({ provenance: PROVENANCE });

		// Then: unknown fields cannot become silently discarded source cache content.
		await expect(read).rejects.toBeInstanceOf(OpinionSourceCacheCorruptError);
	});
});

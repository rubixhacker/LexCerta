import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import migration from "../migrations/0005_opinion_source_cache.sql?raw";
import { createD1R2OpinionSourceStore } from "../src/cache/d1-r2-opinion-source-store.js";
import type { OpinionSourceCacheState } from "../src/verification/opinion-source-cache.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const PROVENANCE = {
	canonicalUrl: "https://www.courtlistener.com/opinion/123/example/",
	clusterId: 123,
	opinionId: 456,
} as const;
let commitNow = NOW;

function at(milliseconds: number): Date {
	return new Date(NOW.getTime() + milliseconds);
}

function positive(canonicalUrl: string = PROVENANCE.canonicalUrl) {
	return {
		kind: "positive" as const,
		provenance: { ...PROVENANCE, canonicalUrl },
		representation: "plain_text" as const,
		sourceText: "durable source",
	};
}

function negative(canonicalUrl: string = PROVENANCE.canonicalUrl) {
	return { kind: "negative" as const, provenance: { ...PROVENANCE, canonicalUrl } };
}

function storedNegative(state: OpinionSourceCacheState) {
	if (state.kind === "negative") return state;
	throw new TypeError("expected stored negative state");
}

async function reset(): Promise<void> {
	commitNow = NOW;
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
	return createD1R2OpinionSourceStore({
		bucket: env.OPINION_CACHE,
		clock: { now: () => commitNow },
		database: env.DB,
	});
}

async function fill(
	item: ReturnType<typeof store>,
	ownerToken: string,
	now: Date,
	observation: ReturnType<typeof positive> | ReturnType<typeof negative>,
) {
	commitNow = now;
	await item.acquireLease({ now, opinionId: PROVENANCE.opinionId, ownerToken });
	return item.fillLease({ now, ownerToken, observation });
}

describe("D1 opinion-source negative expiry", () => {
	beforeEach(reset);

	it("purges a standalone negative exactly at the twenty-four-hour boundary", async () => {
		// Given: a durable successful no-source observation.
		const item = store();
		const saved = await fill(item, "negative", NOW, negative());
		if (saved.kind !== "stored") throw new TypeError("expected stored negative");
		const expected = storedNegative(saved.state);
		const expiry = at(24 * 60 * 60 * 1_000);
		await item.acquireLease({ now: expiry, opinionId: PROVENANCE.opinionId, ownerToken: "purger" });

		// When: the active owner applies the pure negative-expiry transition.
		const result = await item.purgeExpiredNegativeLease({
			expected,
			now: expiry,
			opinionId: PROVENANCE.opinionId,
			ownerToken: "purger",
		});

		// Then: the expired standalone absence is deleted and cannot support any conclusion.
		expect(result).toEqual({ kind: "purged", state: null });
		expect(await item.read({ provenance: PROVENANCE })).toBeNull();
	});

	it("preserves superseded positive metadata behind reversal_pending at negative expiry", async () => {
		// Given: a confirmed negative reversal that retains previous R2 positive evidence.
		const item = store();
		await fill(item, "positive", NOW, positive());
		const firstNegative = at(1_000);
		await fill(item, "negative-a", firstNegative, negative());
		const confirmedAt = at(24 * 60 * 60 * 1_000 + 1_000);
		const saved = await fill(item, "negative-b", confirmedAt, negative());
		if (saved.kind !== "stored") throw new TypeError("expected confirmed negative");
		const expected = storedNegative(saved.state);
		const expiry = at(48 * 60 * 60 * 1_000 + 1_000);
		await item.acquireLease({ now: expiry, opinionId: PROVENANCE.opinionId, ownerToken: "purger" });

		// When: the confirmed negative reaches its own freshness boundary.
		const result = await item.purgeExpiredNegativeLease({
			expected,
			now: expiry,
			opinionId: PROVENANCE.opinionId,
			ownerToken: "purger",
		});

		// Then: prior evidence is retained only in conservative source-change state.
		expect(result).toMatchObject({
			kind: "purged",
			state: { kind: "reversal_pending", superseded: { provenance: PROVENANCE } },
		});
	});

	it("persists a valid maximal-URL source-change state under the bounded D1 limit", async () => {
		// Given: canonical provenance at the accepted 2,048-character URL boundary.
		const canonicalUrl = `https://www.courtlistener.com/${"a".repeat(2_018)}`;
		expect(canonicalUrl).toHaveLength(2_048);
		const item = store();
		await fill(item, "positive", NOW, positive(canonicalUrl));

		// When: a fresh negative transitions it into reversal_pending.
		const saved = await fill(item, "negative", at(1_000), negative(canonicalUrl));

		// Then: the full bounded provenance persists rather than silently dropping the transition.
		expect(saved).toMatchObject({
			kind: "stored",
			state: { kind: "reversal_pending", superseded: { provenance: { canonicalUrl } } },
		});
		const row = await env.DB.prepare(
			"SELECT state_json FROM opinion_source_states WHERE opinion_id = ?1",
		)
			.bind(PROVENANCE.opinionId)
			.first<{ readonly state_json: string }>();
		expect(row?.state_json.length).toBeGreaterThan(4_096);
	});
});

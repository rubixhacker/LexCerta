import { SELF, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createD1R2OpinionSourceStore } from "../src/cache/d1-r2-opinion-source-store.js";
import { setupQuoteWorker } from "./fixtures/issue-7-quote-worker.js";

const CLUSTER_ID = 108713;
const OPINION_ID = 2201;
const CANONICAL_URL = "https://www.courtlistener.com/opinion/108713/example/";
const PROVENANCE = { canonicalUrl: CANONICAL_URL, clusterId: CLUSTER_ID, opinionId: OPINION_ID };
const MATCH = "The durable opinion contains this exact legal sentence.";
const OLD_SOURCE = `<p>${MATCH} OLD_OPINION_SENTINEL</p>`;

afterEach(() => vi.unstubAllGlobals());

async function seed(input: {
	readonly kind: "negative" | "positive";
	readonly observedAt: Date;
	readonly sourceText?: string;
}) {
	const store = createD1R2OpinionSourceStore({ bucket: env.OPINION_CACHE, database: env.DB });
	await store.acquireLease({
		now: input.observedAt,
		opinionId: OPINION_ID,
		ownerToken: "seed-owner",
	});
	return store.fillLease({
		now: input.observedAt,
		ownerToken: "seed-owner",
		observation:
			input.kind === "negative"
				? { kind: "negative", provenance: PROVENANCE }
				: {
						kind: "positive",
						provenance: PROVENANCE,
						representation: "html_with_citations",
						sourceText: input.sourceText ?? OLD_SOURCE,
					},
	});
}

function opinionRequests(requests: readonly Request[]): readonly Request[] {
	return requests.filter((request) => new URL(request.url).pathname.includes("/opinions/"));
}

describe("Issue 8 durable opinion evidence", () => {
	it("reuses fresh R2 evidence across requests with metadata-only public and D1 state", async () => {
		// Given: a cold authenticated quote request with a unique legal-text sentinel.
		const fixture = await setupQuoteWorker({
			opinions: [
				{
					body: {
						cluster: `https://www.courtlistener.com/api/rest/v4/clusters/${CLUSTER_ID}/`,
						html_with_citations: OLD_SOURCE,
						id: OPINION_ID,
					},
					id: OPINION_ID,
				},
			],
		});

		// When: separately constructed Worker requests verify the same quotation.
		const first = JSON.stringify(await (await SELF.fetch(fixture.request(MATCH))).json());
		const second = JSON.stringify(await (await SELF.fetch(fixture.request(MATCH))).json());

		// Then: both verify, one opinion GET fills R2, and legal content stays out of D1/public output.
		expect(first).toContain('"outcome":"verified"');
		expect(second).toContain('"freshness":"fresh"');
		expect(opinionRequests(fixture.outbound)).toHaveLength(1);
		const state = await env.DB.prepare(
			"SELECT state_json FROM opinion_source_states WHERE opinion_id = ?1",
		)
			.bind(OPINION_ID)
			.first<{ readonly state_json: string }>();
		expect(state?.state_json).not.toContain("OLD_OPINION_SENTINEL");
		expect(`${first}${second}`).not.toContain("OLD_OPINION_SENTINEL");
		expect((await env.OPINION_CACHE.list()).objects).toHaveLength(1);
	});

	it("returns a disclosed stale positive when admitted revalidation fails", async () => {
		// Given: retained positive evidence older than thirty days and an unavailable upstream opinion.
		const fixture = await setupQuoteWorker({ opinions: [{ id: OPINION_ID, status: 503 }] });
		const staleAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000 - 1);
		await seed({ kind: "positive", observedAt: staleAt });

		// When: the Worker attempts exactly one admitted revalidation.
		const body = JSON.stringify(await (await SELF.fetch(fixture.request(MATCH))).json());

		// Then: retained evidence verifies only as stale with its original retrieval timestamp.
		expect(body).toContain('"outcome":"verified"');
		expect(body).toContain('"freshness":"stale"');
		expect(body).toContain(staleAt.toISOString());
		expect(opinionRequests(fixture.outbound)).toHaveLength(1);
	});

	it("revalidates a stale positive into a new immutable R2 version", async () => {
		// Given: stale retained evidence and a changed fresh representation for the same opinion.
		const changed = `<p>${MATCH} NEW_OPINION_SENTINEL</p>`;
		const fixture = await setupQuoteWorker({
			opinions: [
				{
					body: {
						cluster: `https://www.courtlistener.com/api/rest/v4/clusters/${CLUSTER_ID}/`,
						html_with_citations: changed,
						id: OPINION_ID,
					},
					id: OPINION_ID,
				},
			],
		});
		await seed({
			kind: "positive",
			observedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000 - 1),
		});

		// When: the Worker successfully revalidates the trusted opinion.
		const body = JSON.stringify(await (await SELF.fetch(fixture.request(MATCH))).json());

		// Then: fresh evidence is active while both content-addressed versions remain retained.
		expect(body).toContain('"freshness":"fresh"');
		expect((await env.OPINION_CACHE.list()).objects).toHaveLength(2);
		const versions = await env.DB.prepare(
			"SELECT content_sha256_hex FROM opinion_source_object_versions WHERE opinion_id = ?1",
		)
			.bind(OPINION_ID)
			.all();
		expect(versions.results).toHaveLength(2);
	});

	it("keeps fresh and expired negative evidence conservative", async () => {
		// Given: a current negative observation for a trusted opinion.
		const fixture = await setupQuoteWorker({ opinions: [{ id: OPINION_ID, status: 503 }] });
		await seed({ kind: "negative", observedAt: new Date() });

		// When: the Worker reads it during the negative freshness window.
		const body = JSON.stringify(await (await SELF.fetch(fixture.request(MATCH))).json());

		// Then: it is indeterminate, never not_found, and performs no opinion GET.
		expect(body).toContain('"reason":"incomplete"');
		expect(body).not.toContain('"outcome":"not_found"');
		expect(opinionRequests(fixture.outbound)).toHaveLength(0);
	});

	it("revalidates an expired negative and never falls back to not_found", async () => {
		// Given: a negative observation at the exact expiry boundary and an unavailable upstream.
		const fixture = await setupQuoteWorker({ opinions: [{ id: OPINION_ID, status: 503 }] });
		await seed({
			kind: "negative",
			observedAt: new Date(Date.now() - 24 * 60 * 60 * 1_000),
		});

		// When: the Worker attempts the required fresh opinion observation.
		const body = JSON.stringify(await (await SELF.fetch(fixture.request(MATCH))).json());

		// Then: one opinion GET fails indeterminately and cannot become a durable absence claim.
		expect(body).toContain('"reason":"upstream_unavailable"');
		expect(body).not.toContain('"outcome":"not_found"');
		expect(opinionRequests(fixture.outbound)).toHaveLength(1);
	});

	it("marks the first successful negative against stale positive evidence as source_changed", async () => {
		// Given: stale retained positive evidence and a successful upstream missing response.
		const fixture = await setupQuoteWorker({ opinions: [{ id: OPINION_ID, status: 404 }] });
		await seed({
			kind: "positive",
			observedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000 - 1),
		});

		// When: revalidation observes the contradiction.
		const body = JSON.stringify(await (await SELF.fetch(fixture.request(MATCH))).json());

		// Then: public evidence is source_changed and D1 retains a reversal-pending state.
		expect(body).toContain('"reason":"source_changed"');
		const state = await env.DB.prepare(
			"SELECT state_json FROM opinion_source_states WHERE opinion_id = ?1",
		)
			.bind(OPINION_ID)
			.first<{ readonly state_json: string }>();
		expect(state?.state_json).toContain('"kind":"reversal_pending"');
	});

	it("confirms an old pending reversal and restores a later positive", async () => {
		// Given: a first negative older than the confirmation window with its positive retained.
		const fixture = await setupQuoteWorker({ opinions: [{ id: OPINION_ID, status: 404 }] });
		const firstNegativeAt = new Date(Date.now() - 24 * 60 * 60 * 1_000 - 1);
		await seed({
			kind: "positive",
			observedAt: new Date(firstNegativeAt.getTime() - 30 * 24 * 60 * 60 * 1_000),
		});
		await seed({ kind: "negative", observedAt: firstNegativeAt });

		// When: a second successful missing observation arrives after the boundary.
		const body = JSON.stringify(await (await SELF.fetch(fixture.request(MATCH))).json());

		// Then: the accepted negative remains conservative and is stored as negative state.
		expect(body).toContain('"reason":"incomplete"');
		const state = await env.DB.prepare(
			"SELECT state_json FROM opinion_source_states WHERE opinion_id = ?1",
		)
			.bind(OPINION_ID)
			.first<{ readonly state_json: string }>();
		expect(state?.state_json).toContain('"kind":"negative"');
	});

	it("restores a fresh positive immediately while reversal is pending", async () => {
		// Given: a pending reversal and a renewed source representation containing the quotation.
		const fixture = await setupQuoteWorker({
			opinions: [
				{
					body: {
						cluster: `https://www.courtlistener.com/api/rest/v4/clusters/${CLUSTER_ID}/`,
						html_with_citations: OLD_SOURCE,
						id: OPINION_ID,
					},
					id: OPINION_ID,
				},
			],
		});
		const staleAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000);
		await seed({ kind: "positive", observedAt: staleAt });
		await seed({ kind: "negative", observedAt: new Date(staleAt.getTime() + 1_000) });

		// When: the Worker observes that positive evidence has returned.
		const body = JSON.stringify(await (await SELF.fetch(fixture.request(MATCH))).json());

		// Then: verification is fresh and the pending reversal is cleared durably.
		expect(body).toContain('"outcome":"verified"');
		expect(body).toContain('"freshness":"fresh"');
		const state = await env.DB.prepare(
			"SELECT state_json FROM opinion_source_states WHERE opinion_id = ?1",
		)
			.bind(OPINION_ID)
			.first<{ readonly state_json: string }>();
		expect(state?.state_json).toContain('"kind":"positive"');
	});

	it("rejects tampered R2 bytes without an upstream request or content leak", async () => {
		// Given: fresh positive metadata whose referenced R2 bytes no longer match the stored hash.
		const fixture = await setupQuoteWorker({ opinions: [{ id: OPINION_ID }] });
		await seed({ kind: "positive", observedAt: new Date() });
		const key = (await env.OPINION_CACHE.list()).objects[0]?.key;
		if (key === undefined) throw new TypeError("expected seeded R2 object");
		await env.OPINION_CACHE.put(key, "TAMPERED_OPINION_SENTINEL");

		// When: the real Worker reads the corrupt durable dependency.
		const body = JSON.stringify(await (await SELF.fetch(fixture.request(MATCH))).json());

		// Then: it fails closed, spends no opinion request, and exposes neither legal body.
		expect(body).toContain('"reason":"upstream_unavailable"');
		expect(body).not.toContain("TAMPERED_OPINION_SENTINEL");
		expect(opinionRequests(fixture.outbound)).toHaveLength(0);
	});

	it("takes over an expired held lease and fills once", async () => {
		// Given: an abandoned opinion lease that expires shortly after request arrival.
		const fixture = await setupQuoteWorker({
			opinions: [
				{
					body: {
						cluster: `https://www.courtlistener.com/api/rest/v4/clusters/${CLUSTER_ID}/`,
						html_with_citations: OLD_SOURCE,
						id: OPINION_ID,
					},
					id: OPINION_ID,
				},
			],
		});
		await env.DB.prepare(
			"INSERT INTO opinion_source_fetch_leases (opinion_id, owner_token, expires_at) VALUES (?1, ?2, ?3)",
		)
			.bind(OPINION_ID, "abandoned-owner", new Date(Date.now() + 75).toISOString())
			.run();

		// When: a new Worker request waits through exact expiry and takes ownership.
		const body = JSON.stringify(await (await SELF.fetch(fixture.request(MATCH))).json());

		// Then: takeover verifies through one opinion GET and one durable object.
		expect(body).toContain('"outcome":"verified"');
		expect(opinionRequests(fixture.outbound)).toHaveLength(1);
		expect((await env.OPINION_CACHE.list()).objects).toHaveLength(1);
	});
});

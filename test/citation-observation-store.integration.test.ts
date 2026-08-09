import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import migration from "../migrations/0004_citation_source_cache.sql?raw";
import type {
	LeaseFillResult,
	StoredCitationObservation,
} from "../src/cache/citation-observation-store.js";
import { CITATION_FETCH_LEASE_MS } from "../src/cache/citation-observation-store.js";
import {
	CitationSourceStateCorruptError,
	createD1CitationObservationStore,
} from "../src/cache/d1-citation-observation-store.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const CITATION = "347 U.S. 483";
const OWNER = "fetch-owner-a";

function at(milliseconds: number): Date {
	return new Date(NOW.getTime() + milliseconds);
}

function positiveObservation() {
	return {
		kind: "positive" as const,
		cluster: { id: 123, canonicalUrl: "https://www.courtlistener.com/opinion/123/example/" },
	};
}

function storedObservation(result: LeaseFillResult): StoredCitationObservation {
	if (result.kind === "stored") return result.observation;
	throw new TypeError("expected an active lease owner to store an observation");
}

async function reset(): Promise<void> {
	await env.DB.prepare("DROP TABLE IF EXISTS citation_fetch_leases").run();
	await env.DB.prepare("DROP TABLE IF EXISTS citation_source_states").run();
	for (const statement of migration
		.split(";")
		.map((value) => value.trim())
		.filter(Boolean)) {
		await env.DB.prepare(statement).run();
	}
}

describe("D1 citation observation store", () => {
	beforeEach(reset);

	it("uses a ten-second lease that remains longer than the upstream timeout", () => {
		// Given: the fixed upstream timeout is five seconds.
		const upstreamTimeoutMs = 5_000;

		// When: the source-cache lease policy is inspected.
		const leaseDurationMs = CITATION_FETCH_LEASE_MS;

		// Then: in-flight upstream work cannot normally lose its owner lease.
		expect(leaseDurationMs).toBe(10_000);
		expect(leaseDurationMs).toBeGreaterThan(upstreamTimeoutMs);
	});

	it("persists a positive observation only when its active lease owner fills it", async () => {
		// Given: an empty D1 source cache and an owner that acquired the normalized citation lease.
		const store = createD1CitationObservationStore(env.DB);
		await expect(
			store.acquireLease({ normalizedCitation: CITATION, ownerToken: OWNER, now: NOW }),
		).resolves.toEqual({
			kind: "acquired",
			expiresAt: "2026-08-09T12:00:10.000Z",
		});

		// When: that owner records a successful positive CourtListener observation.
		const result = await store.fillLease({
			normalizedCitation: CITATION,
			ownerToken: OWNER,
			now: NOW,
			observation: positiveObservation(),
		});

		// Then: D1 returns the pure positive state with retrieval metadata and releases the lease.
		expect(result).toEqual({
			kind: "stored",
			observation: {
				kind: "positive",
				positive: {
					kind: "positive",
					cluster: {
						id: 123,
						canonicalUrl: "https://www.courtlistener.com/opinion/123/example/",
					},
					retrievedAt: NOW,
				},
			},
		});
		await expect(store.read({ normalizedCitation: CITATION })).resolves.toEqual(
			storedObservation(result),
		);
		await expect(
			store.acquireLease({ normalizedCitation: CITATION, ownerToken: OWNER, now: NOW }),
		).resolves.toMatchObject({
			kind: "acquired",
		});
	});

	it("coalesces concurrent misses so exactly one owner obtains the lease", async () => {
		// Given: sixteen simultaneous callers for one normalized citation.
		const store = createD1CitationObservationStore(env.DB);

		// When: every caller tries to acquire the same D1 fetch lease.
		const results = await Promise.all(
			Array.from({ length: 16 }, (_, index) =>
				store.acquireLease({
					normalizedCitation: CITATION,
					ownerToken: `owner-${index}`,
					now: NOW,
				}),
			),
		);

		// Then: one caller fetches while all other callers receive the held deadline.
		expect(results.filter((result) => result.kind === "acquired")).toHaveLength(1);
		expect(results.filter((result) => result.kind === "held")).toHaveLength(15);
	});

	it("lets a waiting caller recheck the durable fill after the active owner completes", async () => {
		// Given: a waiting caller receives the held deadline while another owner fetches.
		const store = createD1CitationObservationStore(env.DB);
		await store.acquireLease({ normalizedCitation: CITATION, ownerToken: OWNER, now: NOW });
		await expect(
			store.acquireLease({ normalizedCitation: CITATION, ownerToken: "waiter", now: NOW }),
		).resolves.toMatchObject({ kind: "held" });

		// When: the active owner stores its successful source observation.
		await store.fillLease({
			normalizedCitation: CITATION,
			ownerToken: OWNER,
			now: NOW,
			observation: positiveObservation(),
		});

		// Then: the waiter can recheck D1 without issuing a duplicate upstream request.
		await expect(store.read({ normalizedCitation: CITATION })).resolves.toMatchObject({
			kind: "positive",
		});
	});

	it("allows only the current owner to release a fetch lease", async () => {
		// Given: one active normalized-citation lease.
		const store = createD1CitationObservationStore(env.DB);
		await store.acquireLease({ normalizedCitation: CITATION, ownerToken: OWNER, now: NOW });

		// When: another owner attempts the release before the true owner does.
		const otherRelease = await store.releaseLease({
			normalizedCitation: CITATION,
			ownerToken: "other-owner",
		});
		const ownerRelease = await store.releaseLease({
			normalizedCitation: CITATION,
			ownerToken: OWNER,
		});

		// Then: only the owner can release it for a fresh acquisition.
		expect(otherRelease).toEqual({ kind: "lease_unavailable" });
		expect(ownerRelease).toEqual({ kind: "released" });
	});

	it("recovers an expired lease and rejects a late former-owner fill", async () => {
		// Given: a first owner holds a lease that has not expired one millisecond before its deadline.
		const store = createD1CitationObservationStore(env.DB);
		await store.acquireLease({ normalizedCitation: CITATION, ownerToken: OWNER, now: NOW });
		await expect(
			store.acquireLease({ normalizedCitation: CITATION, ownerToken: "owner-b", now: at(9_999) }),
		).resolves.toEqual({ kind: "held", expiresAt: "2026-08-09T12:00:10.000Z" });

		// When: the deadline is reached and a second owner takes over before the former owner fills.
		await expect(
			store.acquireLease({ normalizedCitation: CITATION, ownerToken: "owner-b", now: at(10_000) }),
		).resolves.toEqual({ kind: "acquired", expiresAt: "2026-08-09T12:00:20.000Z" });
		const late = await store.fillLease({
			normalizedCitation: CITATION,
			ownerToken: OWNER,
			now: at(10_000),
			observation: positiveObservation(),
		});

		// Then: only the active owner can persist a successful source observation.
		expect(late).toEqual({ kind: "lease_unavailable" });
		await expect(store.read({ normalizedCitation: CITATION })).resolves.toBeNull();
	});

	it("persists a confirmed negative reversal with the superseded positive metadata", async () => {
		// Given: positive evidence followed by a successful contradictory negative observation.
		const store = createD1CitationObservationStore(env.DB);
		await store.acquireLease({ normalizedCitation: CITATION, ownerToken: OWNER, now: NOW });
		await store.fillLease({
			normalizedCitation: CITATION,
			ownerToken: OWNER,
			now: NOW,
			observation: positiveObservation(),
		});
		await store.acquireLease({
			normalizedCitation: CITATION,
			ownerToken: "owner-b",
			now: at(1_000),
		});
		await store.fillLease({
			normalizedCitation: CITATION,
			ownerToken: "owner-b",
			now: at(1_000),
			observation: { kind: "negative" },
		});

		// When: a second successful negative arrives exactly twenty-four hours after the first.
		await store.acquireLease({
			normalizedCitation: CITATION,
			ownerToken: "owner-c",
			now: at(86_401_000),
		});
		const recorded = await store.fillLease({
			normalizedCitation: CITATION,
			ownerToken: "owner-c",
			now: at(86_401_000),
			observation: { kind: "negative" },
		});

		// Then: D1 retains the confirmed negative and the superseded positive provenance.
		expect(recorded).toEqual({
			kind: "stored",
			observation: {
				kind: "negative",
				negative: { kind: "negative", retrievedAt: at(86_401_000) },
				superseded: {
					kind: "positive",
					cluster: positiveObservation().cluster,
					retrievedAt: NOW,
				},
			},
		});
		await expect(store.read({ normalizedCitation: CITATION })).resolves.toEqual(
			storedObservation(recorded),
		);
	});

	it("rejects corrupt non-CourtListener provenance without exposing the citation", async () => {
		// Given: a D1 row corrupted with an untrusted canonical URL.
		await env.DB.prepare(
			"INSERT INTO citation_source_states (normalized_citation, state_json, updated_at) VALUES (?1, ?2, ?3)",
		)
			.bind(
				CITATION,
				JSON.stringify({
					kind: "positive",
					positive: {
						kind: "positive",
						cluster: { id: 123, canonicalUrl: "https://example.invalid/opinion/123/" },
						retrievedAt: NOW,
					},
				}),
				NOW.toISOString(),
			)
			.run();

		// When: the D1 store reads that provenance boundary.
		const read = createD1CitationObservationStore(env.DB).read({ normalizedCitation: CITATION });

		// Then: it fails generically rather than returning attacker-controlled metadata.
		await expect(read).rejects.toEqual(new CitationSourceStateCorruptError());
	});
});

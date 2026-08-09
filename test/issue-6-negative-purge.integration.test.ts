import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createD1CitationObservationStore } from "../src/cache/d1-citation-observation-store.js";
import type { PositiveCitationObservation } from "../src/verification/citation-source-cache.js";
import {
	createIssue6WorkerFixture,
	positiveState,
	type Issue6WorkerFixture,
} from "./fixtures/issue-6-worker.js";

const CITATION = "347 U.S. 483";
const NOW = new Date("2026-08-09T12:00:00.000Z");
let fixture: Issue6WorkerFixture;

beforeEach(async () => {
	fixture = await createIssue6WorkerFixture(`negative-purge-${crypto.randomUUID()}`);
	vi.stubGlobal("fetch", fixture.source);
});

afterEach(() => vi.unstubAllGlobals());

describe("issue 6 expired negative purge", () => {
	it("removes a standalone expired negative before a public failed revalidation", async () => {
		await fixture.seed(staleNegativeState(null, new Date()));
		fixture.setSourceMode("server");

		const response = await SELF.fetch(fixture.request());
		const row = await sourceStateRow();

		expect(await response.json()).toMatchObject({
			result: {
				isError: true,
				structuredContent: { outcome: "indeterminate", reason: "upstream_unavailable" },
			},
		});
		expect(row).toBeNull();
	});

	it("retains superseded reversal history after a public failed revalidation", async () => {
		const now = new Date();
		const retrievedAt = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1_000);
		const superseded: PositiveCitationObservation = {
			kind: "positive",
			cluster: positiveState(retrievedAt).positive.cluster,
			retrievedAt,
		};
		const stale = staleNegativeState(superseded, now);
		await fixture.seed(stale);
		fixture.setSourceMode("server");

		const response = await SELF.fetch(fixture.request());
		const row = await sourceStateRow();

		expect(await response.json()).toMatchObject({
			result: {
				isError: true,
				structuredContent: { outcome: "indeterminate", reason: "source_changed" },
			},
		});
		expect(JSON.parse(requireStateJson(row))).toMatchObject({
			kind: "reversal_pending",
			superseded: { ...superseded, retrievedAt: superseded.retrievedAt.toISOString() },
			firstNegative: { ...stale.negative, retrievedAt: stale.negative.retrievedAt.toISOString() },
		});
	});

	it("does not purge a state changed after the lease owner reread it", async () => {
		const stale = staleNegativeState(null);
		await fixture.seed(stale);
		const store = createD1CitationObservationStore(env.DB);
		await store.acquireLease({ normalizedCitation: CITATION, ownerToken: "owner", now: NOW });
		await env.DB.prepare(
			"UPDATE citation_source_states SET state_json = ?1 WHERE normalized_citation = ?2",
		)
			.bind(JSON.stringify(positiveState(NOW)), CITATION)
			.run();

		const result = await store.purgeExpiredNegativeLease({
			normalizedCitation: CITATION,
			ownerToken: "owner",
			now: NOW,
			expected: stale,
		});

		expect(result).toEqual({ kind: "state_changed" });
		await expect(store.read({ normalizedCitation: CITATION })).resolves.toEqual({
			kind: "positive",
			positive: { ...positiveState(NOW).positive, retrievedAt: NOW },
		});
	});

	it("rejects an expired owner and a non-owner before purging durable state", async () => {
		const stale = staleNegativeState(null);
		await fixture.seed(stale);
		const store = createD1CitationObservationStore(env.DB);
		await store.acquireLease({ normalizedCitation: CITATION, ownerToken: "owner", now: NOW });

		const otherOwner = await store.purgeExpiredNegativeLease({
			normalizedCitation: CITATION,
			ownerToken: "other-owner",
			now: NOW,
			expected: stale,
		});
		const expiredOwner = await store.purgeExpiredNegativeLease({
			normalizedCitation: CITATION,
			ownerToken: "owner",
			now: new Date(NOW.getTime() + 10_000),
			expected: stale,
		});

		expect(otherOwner).toEqual({ kind: "lease_unavailable" });
		expect(expiredOwner).toEqual({ kind: "lease_unavailable" });
		await expect(store.read({ normalizedCitation: CITATION })).resolves.toEqual(stale);
	});
});

function staleNegativeState(superseded: PositiveCitationObservation | null, now = NOW) {
	return {
		kind: "negative" as const,
		negative: {
			kind: "negative" as const,
			retrievedAt: new Date(now.getTime() - 25 * 60 * 60 * 1_000),
		},
		superseded,
	};
}

async function sourceStateRow(): Promise<{ readonly state_json: string } | null> {
	return env.DB.prepare(
		"SELECT state_json FROM citation_source_states WHERE normalized_citation = ?1",
	)
		.bind(CITATION)
		.first<{ readonly state_json: string }>();
}

function requireStateJson(row: { readonly state_json: string } | null): string {
	if (row !== null) return row.state_json;
	throw new TypeError("expected retained reversal history");
}

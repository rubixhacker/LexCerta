import { describe, expect, it } from "vitest";
import {
	DEFAULT_CITATION_SOURCE_CACHE_POLICY,
	initialCitationSourceCacheState,
	readCitationSourceCache,
	recordCitationSourceObservation,
} from "./citation-source-cache.js";

const START = new Date("2026-08-09T12:00:00.000Z");
const CLUSTER = {
	id: 123,
	canonicalUrl: "https://www.courtlistener.com/opinion/123/example/",
} as const;

function atOffset(start: Date, milliseconds: number): Date {
	return new Date(start.getTime() + milliseconds);
}

function positive(state = initialCitationSourceCacheState(), now = START) {
	return recordCitationSourceObservation({
		state,
		now,
		observation: { kind: "positive", cluster: CLUSTER },
	});
}

function negative(state = initialCitationSourceCacheState(), now = START) {
	return recordCitationSourceObservation({ state, now, observation: { kind: "negative" } });
}

describe("citation source cache", () => {
	it("returns a fresh positive for the thirty-day freshness window", () => {
		// Given: a successful positive CourtListener observation.
		const state = positive();

		// When: it is read one millisecond before its default freshness expires.
		const decision = readCitationSourceCache({
			state,
			now: atOffset(START, DEFAULT_CITATION_SOURCE_CACHE_POLICY.positiveFreshnessMs - 1),
		});

		// Then: it is a fresh verified result without a required revalidation.
		expect(decision).toEqual({
			kind: "verified",
			freshness: "fresh",
			requiresRevalidation: false,
			positive: { kind: "positive", cluster: CLUSTER, retrievedAt: START },
		});
	});

	it("retains an expired positive only as explicitly stale evidence", () => {
		// Given: a retained positive observation at its freshness boundary.
		const state = positive();

		// When: it is read after thirty days.
		const decision = readCitationSourceCache({
			state,
			now: atOffset(START, DEFAULT_CITATION_SOURCE_CACHE_POLICY.positiveFreshnessMs),
		});

		// Then: callers can disclose stale evidence and must revalidate it.
		expect(decision).toEqual({
			kind: "verified",
			freshness: "stale",
			requiresRevalidation: true,
			positive: { kind: "positive", cluster: CLUSTER, retrievedAt: START },
		});
	});

	it("uses a negative only while its twenty-four-hour freshness window remains", () => {
		// Given: a successful source-scoped negative observation.
		const state = negative();

		// When: it is read one millisecond before expiry.
		const decision = readCitationSourceCache({
			state,
			now: atOffset(START, DEFAULT_CITATION_SOURCE_CACHE_POLICY.negativeFreshnessMs - 1),
		});

		// Then: it can support a source-scoped not-found result.
		expect(decision).toEqual({
			kind: "not_found",
			negative: { kind: "negative", retrievedAt: START },
		});
	});

	it("never returns an expired negative as not-found evidence", () => {
		// Given: an expired negative observation.
		const state = negative();

		// When: it is read at the freshness boundary.
		const decision = readCitationSourceCache({
			state,
			now: atOffset(START, DEFAULT_CITATION_SOURCE_CACHE_POLICY.negativeFreshnessMs),
		});

		// Then: the cache requires a refresh rather than claiming source absence.
		expect(decision).toEqual({
			kind: "indeterminate",
			reason: "stale_negative",
			requiresRevalidation: true,
		});
	});

	it("requires a refresh for a cache miss", () => {
		// Given: no durable observation for a normalized citation.
		const state = initialCitationSourceCacheState();

		// When: the source cache is read.
		const decision = readCitationSourceCache({ state, now: START });

		// Then: the caller must obtain a successful upstream observation.
		expect(decision).toEqual({
			kind: "indeterminate",
			reason: "cache_miss",
			requiresRevalidation: true,
		});
	});

	it("preserves positive evidence and reports source_changed after a contradictory negative", () => {
		// Given: retained positive evidence and a later successful source negative.
		const state = negative(positive(), atOffset(START, 1_000));

		// When: the changed source state is read.
		const decision = readCitationSourceCache({ state, now: atOffset(START, 1_000) });

		// Then: verification stops conclusively while the superseded positive remains durable.
		expect(state).toEqual({
			kind: "reversal_pending",
			superseded: { kind: "positive", cluster: CLUSTER, retrievedAt: START },
			firstNegative: { kind: "negative", retrievedAt: atOffset(START, 1_000) },
		});
		expect(decision).toEqual({
			kind: "indeterminate",
			reason: "source_changed",
			requiresRevalidation: true,
		});
	});

	it("requires a second negative at least twenty-four hours after the first before accepting reversal", () => {
		// Given: a positive contradicted by its first negative observation.
		const firstNegativeAt = atOffset(START, 1_000);
		const pending = negative(positive(), firstNegativeAt);

		// When: another successful negative arrives before the confirmation window.
		const stillPending = negative(
			pending,
			atOffset(firstNegativeAt, DEFAULT_CITATION_SOURCE_CACHE_POLICY.reversalConfirmationMs - 1),
		);

		// Then: the retained positive cannot be replaced yet.
		expect(stillPending).toEqual(pending);
	});

	it("accepts a confirmed negative reversal after twenty-four hours", () => {
		// Given: a positive contradicted by its first negative observation.
		const firstNegativeAt = atOffset(START, 1_000);
		const pending = negative(positive(), firstNegativeAt);
		const confirmedAt = atOffset(
			firstNegativeAt,
			DEFAULT_CITATION_SOURCE_CACHE_POLICY.reversalConfirmationMs,
		);

		// When: a second successful negative arrives at the confirmation boundary.
		const state = negative(pending, confirmedAt);

		// Then: the confirmed fresh negative retains its superseded positive metadata.
		expect(state).toEqual({
			kind: "negative",
			negative: { kind: "negative", retrievedAt: confirmedAt },
			superseded: { kind: "positive", cluster: CLUSTER, retrievedAt: START },
		});
	});

	it("restores positive evidence immediately when a changed source supports it again", () => {
		// Given: a source reversal awaiting confirmation.
		const pending = negative(positive(), atOffset(START, 1_000));
		const renewedAt = atOffset(START, 2_000);

		// When: the source returns positive evidence again.
		const state = positive(pending, renewedAt);

		// Then: normal fresh positive operation resumes immediately.
		expect(state).toEqual({
			kind: "positive",
			positive: { kind: "positive", cluster: CLUSTER, retrievedAt: renewedAt },
		});
	});
});

import { describe, expect, it } from "vitest";
import {
	DEFAULT_OPINION_SOURCE_CACHE_POLICY,
	initialOpinionSourceCacheState,
	purgeExpiredOpinionNegative,
	readOpinionSourceCache,
	recordOpinionSourceObservation,
	type PositiveOpinionSourceObservation,
} from "./opinion-source-cache.js";

const START = new Date("2026-08-09T12:00:00.000Z");
const PROVENANCE = {
	opinionId: 456,
	clusterId: 123,
	canonicalUrl: "https://www.courtlistener.com/opinion/456/example/",
} as const;
const POSITIVE = {
	kind: "positive" as const,
	provenance: PROVENANCE,
	representation: "html_with_citations" as const,
	contentHash: "sha256:8d84b0a57e4430ca2ba6a9d1b52d816f",
	objectKey: "opinions/456/sha256-8d84b0a57e4430ca2ba6a9d1b52d816f",
};

type Assert<T extends true> = T;
type PositiveMetadataExcludesSourceText = Assert<
	"sourceText" extends keyof PositiveOpinionSourceObservation ? false : true
>;
type PositiveMetadataExcludesQuote = Assert<
	"quote" extends keyof PositiveOpinionSourceObservation ? false : true
>;

function atOffset(start: Date, milliseconds: number): Date {
	return new Date(start.getTime() + milliseconds);
}

function positive(state = initialOpinionSourceCacheState(), now = START) {
	return recordOpinionSourceObservation({ state, now, observation: POSITIVE });
}

function negative(state = initialOpinionSourceCacheState(), now = START) {
	return recordOpinionSourceObservation({
		state,
		now,
		observation: { kind: "negative", provenance: PROVENANCE },
	});
}

describe("opinion source cache", () => {
	it("returns fresh R2 metadata during the thirty-day positive window", () => {
		// Given: a complete canonical opinion representation in the source cache.
		const state = positive();

		// When: it is read one millisecond before positive freshness expires.
		const decision = readOpinionSourceCache({
			state,
			now: atOffset(START, DEFAULT_OPINION_SOURCE_CACHE_POLICY.positiveFreshnessMs - 1),
		});

		// Then: only metadata identifies the fresh R2-backed representation.
		expect(decision).toEqual({
			kind: "available",
			freshness: "fresh",
			requiresRevalidation: false,
			positive: { ...POSITIVE, retrievedAt: START },
		});
	});

	it("retains expired positive metadata only as disclosed stale fallback", () => {
		// Given: a retained positive source observation.
		const state = positive();

		// When: it is read at the positive freshness boundary.
		const decision = readOpinionSourceCache({
			state,
			now: atOffset(START, DEFAULT_OPINION_SOURCE_CACHE_POLICY.positiveFreshnessMs),
		});

		// Then: consumers receive a stale fallback and must revalidate it.
		expect(decision).toMatchObject({
			kind: "available",
			freshness: "stale",
			requiresRevalidation: true,
			positive: { contentHash: POSITIVE.contentHash, objectKey: POSITIVE.objectKey },
		});
	});

	it("treats fresh negative evidence as source-unavailable metadata rather than text", () => {
		// Given: a successful lookup with no usable canonical source representation.
		const state = negative();

		// When: it is read during the negative freshness window.
		const decision = readOpinionSourceCache({
			state,
			now: atOffset(START, DEFAULT_OPINION_SOURCE_CACHE_POLICY.negativeFreshnessMs - 1),
		});

		// Then: it reports only source availability metadata, never a conclusion or legal text.
		expect(decision).toEqual({
			kind: "source_unavailable",
			requiresRevalidation: false,
			negative: { kind: "negative", provenance: PROVENANCE, retrievedAt: START },
		});
	});

	it("does not let an expired negative support any decision", () => {
		// Given: a successful negative source observation.
		const state = negative();

		// When: it reaches the exact twenty-four-hour boundary.
		const decision = readOpinionSourceCache({
			state,
			now: atOffset(START, DEFAULT_OPINION_SOURCE_CACHE_POLICY.negativeFreshnessMs),
		});

		// Then: consumers must revalidate instead of treating absence as evidence.
		expect(decision).toEqual({
			kind: "indeterminate",
			reason: "stale_negative",
			requiresRevalidation: true,
		});
	});

	it("preserves a superseded positive and exposes source_changed after the first fresh negative", () => {
		// Given: a previously successful source representation.
		const previous = positive();

		// When: a fresh lookup cannot provide that source representation.
		const state = negative(previous, atOffset(START, 1_000));

		// Then: the replacement is pending and the old R2 metadata remains retained internally.
		expect(state).toEqual({
			kind: "reversal_pending",
			superseded: { ...POSITIVE, retrievedAt: START },
			firstNegative: {
				kind: "negative",
				provenance: PROVENANCE,
				retrievedAt: atOffset(START, 1_000),
			},
		});
		expect(readOpinionSourceCache({ state, now: atOffset(START, 1_000) })).toEqual({
			kind: "indeterminate",
			reason: "source_changed",
			requiresRevalidation: true,
		});
	});

	it("requires a second negative at least twenty-four hours later before accepting reversal", () => {
		// Given: a first negative that contradicted retained positive evidence.
		const firstNegativeAt = atOffset(START, 1_000);
		const pending = negative(positive(), firstNegativeAt);

		// When: the second successful negative arrives one millisecond too early.
		const state = negative(
			pending,
			atOffset(firstNegativeAt, DEFAULT_OPINION_SOURCE_CACHE_POLICY.reversalConfirmationMs - 1),
		);

		// Then: the cache keeps the source change pending.
		expect(state).toEqual(pending);
	});

	it("confirms a second negative at the exact twenty-four-hour boundary", () => {
		// Given: a pending source reversal.
		const firstNegativeAt = atOffset(START, 1_000);
		const pending = negative(positive(), firstNegativeAt);
		const confirmedAt = atOffset(
			firstNegativeAt,
			DEFAULT_OPINION_SOURCE_CACHE_POLICY.reversalConfirmationMs,
		);

		// When: the second successful negative occurs at the required boundary.
		const state = negative(pending, confirmedAt);

		// Then: the negative is fresh source-unavailable metadata and preserves its predecessor.
		expect(state).toEqual({
			kind: "negative",
			negative: { kind: "negative", provenance: PROVENANCE, retrievedAt: confirmedAt },
			superseded: { ...POSITIVE, retrievedAt: START },
		});
	});

	it("restores a renewed positive representation immediately", () => {
		// Given: a source change awaiting confirmation.
		const pending = negative(positive(), atOffset(START, 1_000));
		const renewedAt = atOffset(START, 2_000);

		// When: CourtListener again returns the canonical representation.
		const state = positive(pending, renewedAt);

		// Then: normal positive use resumes without retaining the pending reversal.
		expect(state).toEqual({ kind: "positive", positive: { ...POSITIVE, retrievedAt: renewedAt } });
	});

	it("purges an expired standalone negative but retains superseded positive metadata", () => {
		// Given: an accepted negative reversal with a retained previous representation.
		const firstNegativeAt = atOffset(START, 1_000);
		const confirmedAt = atOffset(
			firstNegativeAt,
			DEFAULT_OPINION_SOURCE_CACHE_POLICY.reversalConfirmationMs,
		);
		const confirmed = negative(negative(positive(), firstNegativeAt), confirmedAt);

		// When: the accepted negative itself expires.
		const state = purgeExpiredOpinionNegative({
			state: confirmed,
			now: atOffset(confirmedAt, DEFAULT_OPINION_SOURCE_CACHE_POLICY.negativeFreshnessMs),
		});

		// Then: the prior R2 metadata remains only behind a conservative source-change state.
		expect(state).toMatchObject({
			kind: "reversal_pending",
			superseded: { contentHash: POSITIVE.contentHash, objectKey: POSITIVE.objectKey },
		});
	});
});

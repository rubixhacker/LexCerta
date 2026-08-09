import { describe, expect, it } from "vitest";
import type { CitationObservationStore } from "../cache/citation-observation-store.js";
import { createCachedCitationGateway } from "./cached-citation-gateway.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");

describe("cached citation gateway held leases", () => {
	it("returns a rechecked source change while a held owner lease is still active", async () => {
		// Given: the owner has durably stored a source reversal before its lease has expired.
		let reads = 0;
		let waits = 0;
		const store: CitationObservationStore = {
			read: async () => {
				reads += 1;
				return reads === 1
					? null
					: {
							kind: "reversal_pending",
							superseded: {
								kind: "positive",
								cluster: {
									id: 123,
									canonicalUrl: "https://www.courtlistener.com/opinion/123/example/",
								},
								retrievedAt: new Date("2026-07-01T12:00:00.000Z"),
							},
							firstNegative: {
								kind: "negative",
								retrievedAt: NOW,
							},
						};
			},
			acquireLease: async () => ({ kind: "held", expiresAt: "2026-08-09T12:00:10.000Z" }),
			fillLease: async () => ({ kind: "lease_unavailable" }),
			purgeExpiredNegativeLease: async () => ({ kind: "lease_unavailable" }),
			releaseLease: async () => ({ kind: "lease_unavailable" }),
		};
		const gateway = createCachedCitationGateway({
			now: () => NOW,
			ownerToken: () => "waiter",
			store,
			upstream: {
				lookup: async () => ({ kind: "not_found", retrievedAt: NOW.toISOString() }),
			},
			waitForFill: async () => {
				waits += 1;
			},
		});

		// When: the waiter rechecks the durable source state.
		const result = await gateway.lookup({
			volume: 347,
			reporter: "U.S.",
			page: 483,
			normalizedCitation: "347 U.S. 483",
		});

		// Then: it returns the conservative source_changed result after one bounded recheck.
		expect(result).toEqual({ kind: "indeterminate", reason: "source_changed" });
		expect(waits).toBe(1);
	});
});

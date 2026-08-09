import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createD1CitationObservationStore } from "../src/cache/d1-citation-observation-store.js";
import {
	createIssue6WorkerFixture,
	pendingReversalState,
	type Issue6WorkerFixture,
} from "./fixtures/issue-6-worker.js";

let fixture: Issue6WorkerFixture;

beforeEach(async () => {
	fixture = await createIssue6WorkerFixture(`race-${crypto.randomUUID()}`);
	vi.stubGlobal("fetch", fixture.source);
});

afterEach(() => vi.unstubAllGlobals());

describe("issue 6 cache races through the Worker", () => {
	it("coalesces concurrent cold requests behind one CourtListener POST", async () => {
		const [first, second] = await Promise.all([
			SELF.fetch(fixture.request()),
			SELF.fetch(fixture.request()),
		]);

		expect(await first.json()).toMatchObject({
			result: { structuredContent: { outcome: "verified" } },
		});
		expect(await second.json()).toMatchObject({
			result: { structuredContent: { outcome: "verified" } },
		});
		expect(citationPosts()).toHaveLength(1);
	});

	it("does not store an operational failure before a later successful retry", async () => {
		fixture.setSourceMode("server");
		await SELF.fetch(fixture.request());
		fixture.setSourceMode("matched");

		const retried = await SELF.fetch(fixture.request());

		expect(await retried.json()).toMatchObject({
			result: { structuredContent: { outcome: "verified" } },
		});
		expect(citationPosts()).toHaveLength(2);
		expect(
			await env.DB.prepare(
				"SELECT state_json FROM citation_source_states WHERE normalized_citation = ?1",
			)
				.bind("347 U.S. 483")
				.first<unknown>(),
		).not.toBeNull();
	});

	it("charges a cache hit before denying the third authenticated request", async () => {
		await env.DB.prepare("UPDATE api_key_records SET minute_limit = 2, day_limit = 2").run();
		const first = await SELF.fetch(fixture.request());
		const hit = await SELF.fetch(fixture.request());
		const denied = await SELF.fetch(fixture.request());

		expect(first.status).toBe(200);
		expect(hit.status).toBe(200);
		expect(denied.status).toBe(429);
		expect(citationPosts()).toHaveLength(1);
	});

	it("keeps a 24-hour-minus-one reversal pending and accepts it at the exact boundary", async () => {
		const fixed = new Date("2026-08-09T10:00:00.000Z");
		vi.useFakeTimers();
		vi.setSystemTime(fixed);
		fixture.setSourceMode("absent");
		try {
			await fixture.seed(
				pendingReversalState(new Date(fixed.getTime() - 24 * 60 * 60 * 1_000 + 1)),
			);
			const before = await SELF.fetch(fixture.request());
			await fixture.resetCache();
			await fixture.seed(pendingReversalState(new Date(fixed.getTime() - 24 * 60 * 60 * 1_000)));
			const exact = await SELF.fetch(fixture.request());

			expect(await before.json()).toMatchObject({
				result: { structuredContent: { reason: "source_changed" } },
			});
			expect(await exact.json()).toMatchObject({
				result: { structuredContent: { outcome: "not_found" } },
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("recovers an abandoned durable lease through the public Worker", async () => {
		const store = createD1CitationObservationStore(env.DB);
		await store.acquireLease({
			normalizedCitation: "347 U.S. 483",
			ownerToken: "old-owner",
			now: new Date(Date.now() - 11_000),
		});

		const response = await SELF.fetch(fixture.request());
		const late = await store.fillLease({
			normalizedCitation: "347 U.S. 483",
			ownerToken: "old-owner",
			now: new Date(),
			observation: {
				kind: "positive",
				cluster: { id: 1, canonicalUrl: "https://www.courtlistener.com/opinion/1/old/" },
			},
		});

		expect(await response.json()).toMatchObject({
			result: { structuredContent: { outcome: "verified" } },
		});
		expect(citationPosts()).toHaveLength(1);
		expect(late).toEqual({ kind: "lease_unavailable" });
	});
});

function citationPosts(): Request[] {
	return fixture.outbound.filter((request) => request.method === "POST");
}

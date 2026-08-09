import { SELF, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setupQuoteWorker } from "./fixtures/issue-7-quote-worker.js";

const CLUSTER_ID = 108713;
const OPINION_ID = 2201;
const QUOTE_SENTINEL = "QUOTE_PRIVATE_SENTINEL: exact durable concurrency legal phrase.";
const OPINION_SENTINEL = "OPINION_PRIVATE_SENTINEL";

afterEach(() => vi.unstubAllGlobals());

describe("Issue 8 opinion-cache concurrency and redaction", () => {
	it("coalesces sixteen cold Worker requests and redacts every metadata surface", async () => {
		// Given: sixteen independent authenticated requests for one cold durable opinion identity.
		const warnings: string[] = [];
		const errors: string[] = [];
		vi.spyOn(console, "warn").mockImplementation((...values: readonly unknown[]) => {
			warnings.push(values.map(String).join(" "));
		});
		vi.spyOn(console, "error").mockImplementation((...values: readonly unknown[]) => {
			errors.push(values.map(String).join(" "));
		});
		const fixture = await setupQuoteWorker({
			usage: "high",
			opinions: [
				{
					body: {
						cluster: `https://www.courtlistener.com/api/rest/v4/clusters/${CLUSTER_ID}/`,
						html_with_citations: `<p>${QUOTE_SENTINEL} ${OPINION_SENTINEL}</p>`,
						id: OPINION_ID,
					},
					id: OPINION_ID,
				},
			],
		});
		const authorization = fixture.request(QUOTE_SENTINEL).headers.get("authorization") ?? "";
		const upstreamToken = "fixture-courtlistener-token";

		// When: every request crosses SELF.fetch and constructs its own gateway/store adapter.
		const responses = await Promise.all(
			Array.from({ length: 16 }, () => SELF.fetch(fixture.request(QUOTE_SENTINEL))),
		);
		const bodies = await Promise.all(responses.map((response) => response.text()));

		// Then: one opinion GET/version serves every verified caller without sensitive metadata leakage.
		expect(bodies).toHaveLength(16);
		expect(bodies.map((body) => /"outcome":"([^"]+)"/.exec(body)?.[1] ?? "missing")).toEqual(
			Array.from({ length: 16 }, () => "verified"),
		);
		expect(
			fixture.outbound.filter((request) => new URL(request.url).pathname.includes("/opinions/")),
		).toHaveLength(1);
		const versions = await env.DB.prepare(
			"SELECT metadata_json, object_key FROM opinion_source_object_versions WHERE opinion_id = ?1",
		)
			.bind(OPINION_ID)
			.all<{ readonly metadata_json: string; readonly object_key: string }>();
		expect(versions.results).toHaveLength(1);
		const states = await env.DB.prepare(
			"SELECT state_json FROM opinion_source_states WHERE opinion_id = ?1",
		)
			.bind(OPINION_ID)
			.all<{ readonly state_json: string }>();
		const keys = (await env.OPINION_CACHE.list()).objects.map(({ key }) => key);
		const metadataSurfaces = JSON.stringify({
			bodies,
			errors,
			keys,
			states: states.results,
			versions: versions.results,
			warnings,
		});
		for (const secret of [QUOTE_SENTINEL, OPINION_SENTINEL, authorization, upstreamToken]) {
			expect(metadataSurfaces).not.toContain(secret);
		}
	});
});

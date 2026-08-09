import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createIssue6WorkerFixture,
	pendingReversalState,
	positiveState,
	type Issue6WorkerFixture,
} from "./fixtures/issue-6-worker.js";

let fixture: Issue6WorkerFixture;
const COURTLISTENER_TEST_CREDENTIAL = "fixture-courtlistener-token";

beforeEach(async () => {
	fixture = await createIssue6WorkerFixture(`source-cache-${crypto.randomUUID()}`);
	vi.stubGlobal("fetch", fixture.source);
});

afterEach(() => vi.unstubAllGlobals());

describe("issue 6 source cache through the Worker", () => {
	it("avoids CourtListener for a durable fresh positive cache hit", async () => {
		await SELF.fetch(fixture.request());

		const response = await SELF.fetch(fixture.request());

		expect(await response.json()).toMatchObject({
			result: { structuredContent: { outcome: "verified", evidence: { freshness: "fresh" } } },
		});
		expect(outboundMethods()).toEqual(["GET", "POST"]);
	});

	it("returns retained stale positive evidence when revalidation fails", async () => {
		const retrievedAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000);
		await fixture.seed(positiveState(retrievedAt));
		fixture.setSourceMode("server");

		const response = await SELF.fetch(fixture.request());

		expect(await response.json()).toMatchObject({
			result: {
				structuredContent: {
					outcome: "verified",
					evidence: { freshness: "stale", retrievedAt: retrievedAt.toISOString() },
				},
			},
		});
	});

	it("reuses fresh negative evidence without a second CourtListener POST", async () => {
		fixture.setSourceMode("absent");
		const first = await SELF.fetch(fixture.request());
		const second = await SELF.fetch(fixture.request());

		expect(await first.json()).toMatchObject({
			result: { structuredContent: { outcome: "not_found" } },
		});
		expect(await second.json()).toMatchObject({
			result: { structuredContent: { outcome: "not_found" } },
		});
		expect(outboundMethods()).toEqual(["GET", "POST"]);
	});

	it("never returns not_found from an expired negative", async () => {
		await fixture.seed({
			kind: "negative",
			negative: {
				kind: "negative",
				retrievedAt: new Date(Date.now() - 25 * 60 * 60 * 1_000).toISOString(),
			},
			superseded: null,
		});
		fixture.setSourceMode("server");

		const response = await SELF.fetch(fixture.request());

		expect(await response.json()).toMatchObject({
			result: {
				isError: true,
				structuredContent: { outcome: "indeterminate", reason: "upstream_unavailable" },
			},
		});
		expect(outboundMethods()).toEqual(["GET", "POST"]);
	});

	it("returns source_changed when fresh absence contradicts retained positive evidence", async () => {
		await fixture.seed(positiveState(new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000)));
		fixture.setSourceMode("absent");

		const response = await SELF.fetch(fixture.request());

		expect(await response.json()).toMatchObject({
			result: {
				isError: true,
				structuredContent: { outcome: "indeterminate", reason: "source_changed" },
			},
		});
	});

	it("accepts a confirmed negative reversal at the 24-hour boundary", async () => {
		await fixture.seed(pendingReversalState(new Date(Date.now() - 24 * 60 * 60 * 1_000)));
		fixture.setSourceMode("absent");

		const response = await SELF.fetch(fixture.request());

		expect(await response.json()).toMatchObject({
			result: { isError: false, structuredContent: { outcome: "not_found" } },
		});
	});

	it("restores normal verified output when a pending reversal is renewed positive", async () => {
		await fixture.seed(pendingReversalState(new Date()));

		const response = await SELF.fetch(fixture.request());

		expect(await response.json()).toMatchObject({
			result: {
				isError: false,
				structuredContent: { outcome: "verified", evidence: { freshness: "fresh" } },
			},
		});
	});

	it("fails closed when the authoritative source-cache D1 table is unavailable", async () => {
		await env.DB.prepare("DROP TABLE citation_source_states").run();

		const response = await SELF.fetch(fixture.request());

		expect(await response.json()).toMatchObject({
			result: {
				isError: true,
				structuredContent: { outcome: "indeterminate", reason: "upstream_unavailable" },
			},
		});
		expect(fixture.outbound).toHaveLength(0);
	});

	it("never exposes legal content or credentials in runtime logs, responses, cache, or leases", async () => {
		const sentinelSuffix = "issue-6-redaction-sentinel";
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			const response = await SELF.fetch(fixture.request(`347 U.S. 483, 490 (${sentinelSuffix})`));
			const responseBody = await response.text();
			const persisted = await persistedSourceCacheAndLeases();
			const logged = JSON.stringify([...error.mock.calls, ...warn.mock.calls]);

			expect(JSON.parse(responseBody)).toMatchObject({
				result: { structuredContent: { outcome: "verified" } },
			});
			for (const protectedValue of [
				sentinelSuffix,
				fixture.authorization,
				fixture.authorization.slice("Bearer ".length),
				COURTLISTENER_TEST_CREDENTIAL,
			]) {
				expect(responseBody.includes(protectedValue)).toBe(false);
				expect(persisted.includes(protectedValue)).toBe(false);
				expect(logged.includes(protectedValue)).toBe(false);
			}
		} finally {
			error.mockRestore();
			warn.mockRestore();
		}
	});
});

function outboundMethods(): string[] {
	return fixture.outbound.map((request) => request.method);
}

async function persistedSourceCacheAndLeases(): Promise<string> {
	const [states, leases] = await Promise.all([
		env.DB.prepare("SELECT state_json FROM citation_source_states").all(),
		env.DB.prepare(
			"SELECT normalized_citation, owner_token, expires_at FROM citation_fetch_leases",
		).all(),
	]);
	return JSON.stringify({ states, leases });
}

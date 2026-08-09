import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Issue6WorkerFixture, createIssue6WorkerFixture } from "./fixtures/issue-6-worker.js";

let fixture: Issue6WorkerFixture;

beforeEach(async () => {
	fixture = await createIssue6WorkerFixture(`cache-poison-${crypto.randomUUID()}`);
	vi.stubGlobal("fetch", fixture.source);
});

afterEach(() => vi.unstubAllGlobals());

describe("issue 6 upstream response binding through the Worker", () => {
	it.each([
		["matched", "mismatched_matched"],
		["absent", "mismatched_absent"],
	] as const)("does not persist a mismatched conclusive %s response", async (_kind, sourceMode) => {
		// Given: the trusted CourtListener origin returns a conclusive item for a different citation.
		fixture.setSourceMode(sourceMode);

		// When: the requested citation crosses the public Worker MCP boundary.
		const response = await SELF.fetch(fixture.request());
		const persisted = await env.DB.prepare(
			"SELECT state_json FROM citation_source_states WHERE normalized_citation = ?1",
		)
			.bind("347 U.S. 483")
			.first<unknown>();

		// Then: the caller receives a sanitized indeterminate result and D1 has no source state.
		expect(await response.json()).toMatchObject({
			result: {
				isError: true,
				structuredContent: { outcome: "indeterminate", reason: "incomplete" },
			},
		});
		expect(persisted).toBeNull();
		expect(fixture.outbound.filter((request) => request.method === "POST")).toHaveLength(1);
	});
});

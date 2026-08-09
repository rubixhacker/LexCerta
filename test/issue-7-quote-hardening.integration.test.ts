import { SELF, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setupQuoteWorker } from "./fixtures/issue-7-quote-worker.js";

const EXACT = "The Court in 347 U.S. 483 held: order follows law.";
const RAW = "RAW_QUOTE_SECRET: The Court in 347 U.S. 483 held: order follows law.";
const CLUSTER = "https://www.courtlistener.com/api/rest/v4/clusters/108713/";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("Issue 7 quote hardening through real workerd bindings", () => {
	it.each([
		{ body: { html: `<p>${EXACT}</p>`, id: 2201, cluster: CLUSTER }, representation: "html" },
		{ body: { plain_text: EXACT, id: 2201, cluster: CLUSTER }, representation: "plain_text" },
	] as const)(
		"uses the $representation fallback when preferred source fields are absent",
		async ({ body, representation }) => {
			// Given: one source representation remains available after more-preferred fields are absent.
			const fixture = await setupQuoteWorker({ opinions: [{ body, id: 2201 }] });

			// When: a real Worker verifies the source text.
			const result = JSON.stringify(await (await SELF.fetch(fixture.request(EXACT))).json());

			// Then: it verifies using that representation with precisely one source traversal.
			expect(result).toContain('"outcome":"verified"');
			expect(result).toContain(`"representation":"${representation}"`);
			expect(fixture.outbound).toHaveLength(4);
		},
	);

	it("maps an aborted source transport to timeout without a retry", async () => {
		// Given: case-law request timeout creation immediately yields an aborted signal.
		const native = AbortSignal;
		vi.stubGlobal("AbortSignal", {
			abort: native.abort.bind(native),
			any: () => native.abort(),
			timeout: () => native.abort(),
		});
		const fixture = await setupQuoteWorker({ opinions: [{ failure: "timeout", id: 2201 }] });

		// When: quote verification makes its one source attempt.
		const result = JSON.stringify(await (await SELF.fetch(fixture.request(EXACT))).json());

		// Then: it reports timeout without transmitting a retry.
		expect(result).toContain('"reason":"timeout"');
		expect(fixture.outbound).toHaveLength(4);
	});

	it("maps a thrown source transport to upstream_unavailable without a retry", async () => {
		const fixture = await setupQuoteWorker({ opinions: [{ failure: "throw", id: 2201 }] });
		const result = JSON.stringify(await (await SELF.fetch(fixture.request(EXACT))).json());
		expect(result).toContain('"reason":"upstream_unavailable"');
		expect(fixture.outbound).toHaveLength(4);
	});

	it("keeps raw legal text out of runtime outputs, logs, D1 metadata, and R2 keys", async () => {
		// Given: raw source text with a unique legal-text sentinel and instrumented console methods.
		const logs = [vi.spyOn(console, "error"), vi.spyOn(console, "log"), vi.spyOn(console, "warn")];
		const fixture = await setupQuoteWorker({
			opinions: [
				{ body: { html_with_citations: `<p>${RAW}</p>`, id: 2201, cluster: CLUSTER }, id: 2201 },
			],
		});

		// When: the real Worker stores and returns verified quote evidence.
		const response = JSON.stringify(await (await SELF.fetch(fixture.request(RAW))).json());
		const metadata = await env.DB.prepare(
			"SELECT * FROM opinion_source_metadata WHERE opinion_id = ?1",
		)
			.bind(2201)
			.first();
		const objectKey = String((metadata as { readonly object_key?: string } | null)?.object_key);
		const object = await env.OPINIONS.get(objectKey);

		// Then: only the R2 object body retains raw text; all other runtime observables are redacted.
		expect(response).not.toContain(RAW);
		expect(JSON.stringify(metadata)).not.toContain(RAW);
		expect(objectKey).not.toContain(RAW);
		expect(JSON.stringify(logs.flatMap((spy) => spy.mock.calls))).not.toContain(RAW);
		await expect(object?.text()).resolves.toContain(RAW);
	});

	it.each([
		EXACT.replace("Court", "court"),
		EXACT.replace("order", "… order"),
		EXACT.replace("Court", "[Court]"),
		EXACT.replace("483", "484"),
		"Order follows law: The Court in 347 U.S. 483 held.",
	] as const)("does not accept near-match quote text %s", async (quote) => {
		const fixture = await setupQuoteWorker({
			opinions: [{ body: { id: 2201, cluster: CLUSTER, plain_text: EXACT }, id: 2201 }],
		});
		const result = JSON.stringify(await (await SELF.fetch(fixture.request(quote))).json());
		expect(result).toContain('"outcome":"not_found"');
		expect(fixture.outbound).toHaveLength(4);
	});

	it("coalesces sixteen cold callers behind citation, cluster, and opinion leases", async () => {
		// Given: sixteen simultaneous callers with one cold matching source.
		const fixture = await setupQuoteWorker({
			opinions: [
				{ body: { html_with_citations: `<p>${EXACT}</p>`, id: 2201, cluster: CLUSTER }, id: 2201 },
			],
		});

		// When: every caller uses the same authenticated quote request concurrently.
		const responses = await Promise.all(
			Array.from({ length: 16 }, () => SELF.fetch(fixture.request(EXACT))),
		);
		const payloads = await Promise.all(responses.map((response) => response.json()));

		// Then: all callers verify and CourtListener receives one usage, citation, cluster, and opinion request.
		expect(JSON.stringify(payloads)).not.toContain('"isError":true');
		expect(JSON.stringify(payloads)).toContain('"outcome":"verified"');
		expect(fixture.outbound).toHaveLength(4);
	});
});

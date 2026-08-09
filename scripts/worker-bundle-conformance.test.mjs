import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { assertBundleConformance, runBundleConformance } from "./worker-bundle-conformance.mjs";

test("rejects a report containing a non-fixture outbound attempt", () => {
	// Given: a report with a URL that the CourtListener fixture trap did not permit.
	const report = {
		outbound: {
			attemptedUrls: ["https://evil.example/"],
			unexpectedUrls: ["https://evil.example/"],
		},
	};

	// When: bundle conformance validates the captured network boundary.
	const validate = () => assertBundleConformance(report);

	// Then: no report with an outbound escape can qualify.
	assert.throws(validate, /unexpected outbound/);
});

test("runs the emitted Wrangler bundle through D1 R2 Durable Objects and the fixture trap", async () => {
	// Given: an empty, workspace-local directory for an exact bundle artifact.
	const outdir = mkdtempSync(join(process.cwd(), ".bundle-conformance-test-"));

	try {
		// When: the conformance runner builds and invokes the immutable emitted worker.js.
		const report = await runBundleConformance(outdir);

		// Then: discovery and the 10,000-code-point parse5 path are green without a network escape.
		assert.equal(report.scenarios.discovery.status, 200);
		assert.equal(report.scenarios.quote.outcome, "verified");
		assert.equal(report.outbound.unexpectedUrls.length, 0);
	} finally {
		rmSync(outdir, { force: true, recursive: true });
	}
});

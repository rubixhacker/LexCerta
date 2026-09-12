import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

// The original holdout was opened only after development qualification. Its
// unchanged sources now remain part of the reproducible regression set.
test("all 220 frozen real-source and synthetic MCP vectors pass against PostgreSQL", async () => {
	const directory = await mkdtemp(join(tmpdir(), "lexcerta-corpus-regression-"));
	const reportPath = join(directory, "report.json");
	let executionError;
	try {
		await promisify(execFile)(
			process.execPath,
			["scripts/qualify-corpus.mjs", "--split", "all", "--report", reportPath],
			{
				timeout: 25_000,
				maxBuffer: 1024 * 1024,
			},
		);
	} catch (error) {
		executionError = error;
	}
	const report = JSON.parse(await readFile(reportPath, "utf8"));
	assert.equal(report.status, "completed", `Replay failed; retained report: ${reportPath}`);
	assert.ok(report.gate.passed, JSON.stringify({ reportPath, summary: report.summary }));
	assert.equal(executionError, undefined);
	assert.equal(report.summary.total, 220);
	assert.equal(report.summary.passed, 220);
	assert.equal(report.summary.verified, 128);
	assert.equal(report.summary.notFound, 68);
	assert.equal(report.summary.indeterminate, 24);
	assert.ok(Object.values(report.summary.classCounts).every((count) => count.passed === 60));
	await rm(directory, { recursive: true });
});

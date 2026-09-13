import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const executable = process.env.LEXCERTA_PROMTOOL ?? "promtool";
const version = spawnSync(executable, ["--version"], { encoding: "utf8" });
assert.equal(version.status, 0, "promtool must be installed");
assert.match(
	version.stdout,
	/promtool, version 3\.14\.0\b/,
	"Use the pinned Prometheus 3.14.0 tool",
);
const project = "lexcerta-alert-fixture";
const template = await readFile(
	new URL("../infrastructure/environment/maintenance-missing.promql.tftpl", import.meta.url),
	"utf8",
);
const expression = template.replaceAll("${project_id}", project).trim();
assert.ok(!expression.includes("${"), "All template inputs must be supplied");
const series = (projectId = project, job = "lexcerta-maintenance") =>
	`{__name__="logging.googleapis.com/user/lexcerta_maintenance_healthy", monitored_resource="cloud_run_job", project_id="${projectId}", job_name="${job}"}`;
const check = (time, firing) => ({
	expr: expression,
	eval_time: time,
	exp_samples: firing ? [{ labels: "{}", value: 0 }] : [],
});
const specification = {
	evaluation_interval: "1m",
	tests: [
		{
			name: "never created",
			interval: "1m",
			input_series: [],
			promql_expr_test: [check("0m", true)],
		},
		{
			name: "healthy then absent",
			interval: "1m",
			input_series: [{ series: series(), values: "1 _x121" }],
			promql_expr_test: [check("0m", false), check("119m", false), check("120m", true)],
		},
		{
			name: "another environment cannot hide a missing job",
			interval: "1m",
			input_series: [{ series: series("another-project"), values: "1+0x120" }],
			promql_expr_test: [check("120m", true)],
		},
		{
			name: "another job cannot hide a missing job",
			interval: "1m",
			input_series: [{ series: series(project, "unrelated-job"), values: "1+0x120" }],
			promql_expr_test: [check("120m", true)],
		},
		{
			name: "zero counter points do not prove healthy work",
			interval: "1m",
			input_series: [{ series: series(), values: "0+0x120" }],
			promql_expr_test: [check("120m", true)],
		},
		{
			name: "hourly healthy progress",
			interval: "1m",
			input_series: [{ series: series(), values: "1 _x59 1 _x59 1 _x59" }],
			promql_expr_test: [check("179m", false)],
		},
	],
};
const directory = await mkdtemp(join(tmpdir(), "lexcerta-alert-check-"));
try {
	const path = join(directory, "alert.test.yml");
	// JSON is valid YAML and avoids adding a serialization dependency.
	await writeFile(path, JSON.stringify(specification));
	const result = spawnSync(executable, ["test", "rules", path], {
		encoding: "utf8",
		timeout: 30_000,
		maxBuffer: 64 * 1024,
	});
	assert.equal(result.status, 0, result.stdout + result.stderr);
	console.log("Maintenance alert: eight PromQL evaluations passed across six scenarios.");
} finally {
	await rm(directory, { recursive: true, force: true });
}

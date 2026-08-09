import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	appendFileSync,
	copyFileSync,
	existsSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const generator = fileURLToPath(new URL("./qualify-worker-artifact.mjs", import.meta.url));

test("refuses a tracked source change before creating an artifact directory", () => {
	const repository = mkdtempSync(join(tmpdir(), "lexcerta-artifact-"));
	const outdir = join(repository, "artifact");
	try {
		copyFileSync(generator, join(repository, "qualify-worker-artifact.mjs"));
		writeFileSync(join(repository, "tracked.txt"), "baseline\n");
		runGit(repository, ["init", "--quiet"]);
		runGit(repository, ["config", "user.email", "qualification@example.invalid"]);
		runGit(repository, ["config", "user.name", "Qualification"]);
		runGit(repository, ["add", "."]);
		runGit(repository, ["commit", "--quiet", "-m", "baseline"]);
		appendFileSync(join(repository, "tracked.txt"), "dirty\n");

		const result = spawnSync(process.execPath, ["qualify-worker-artifact.mjs", outdir], {
			cwd: repository,
			encoding: "utf8",
		});

		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /tracked files differ from HEAD/);
		assert.equal(existsSync(outdir), false);
	} finally {
		rmSync(repository, { force: true, recursive: true });
	}
});

function runGit(cwd, args) {
	execFileSync("git", args, { cwd, stdio: "ignore" });
}

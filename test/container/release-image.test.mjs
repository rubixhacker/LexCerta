import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadCandidateImage } from "../../scripts/release-image.mjs";
import { saveImageFixture } from "../fixtures/release-saved-image.mjs";
import { docker, image } from "./runtime-fixture.mjs";

test("a real saved image loads with the same identity and all compiled and migration hashes", async (context) => {
	const root = await mkdtemp(join(tmpdir(), "lexcerta-container-handoff-"));
	try {
		const directory = join(root, "candidate");
		const candidate = await saveImageFixture(directory, image, docker);
		const loaded = await loadCandidateImage(directory, candidate.identity, {
			docker: (args) => docker(...args),
		});
		assert.equal(loaded.image_id, candidate.image_id);
		assert.equal(loaded.stage, "image_verified");
		assert.equal(loaded.approval_granted, false);
		assert.deepEqual(loaded.compiled_sha256, candidate.compiled_sha256);
		assert.deepEqual(loaded.migrations_sha256, candidate.migrations_sha256);
		context.diagnostic(
			JSON.stringify({
				fixture_only: true,
				image: loaded.image_id,
				compiled_files: Object.keys(candidate.compiled_sha256).length,
				migrations: Object.keys(candidate.migrations_sha256).length,
				hosted_origin: false,
				soak_evidence: "synthetic verifier fixture",
			}),
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

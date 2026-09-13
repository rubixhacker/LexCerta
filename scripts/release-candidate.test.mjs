import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	Candidate,
	candidateFiles,
	hashFile,
	releaseIdentity,
	validateSoak,
	verifyCandidate,
} from "./release-candidate.mjs";

const identityEnvironment = {
	GITHUB_REF: "refs/heads/main",
	GITHUB_EVENT_NAME: "workflow_dispatch",
	GITHUB_REPOSITORY: "rubixhacker/LexCerta",
	GITHUB_REPOSITORY_ID: "1157346206",
	GITHUB_REPOSITORY_OWNER_ID: "1776138",
	GITHUB_SHA: "a".repeat(40),
	GITHUB_RUN_ID: "123456789",
	GITHUB_RUN_ATTEMPT: "1",
	GITHUB_WORKFLOW_REF: "rubixhacker/LexCerta/.github/workflows/release.yml@refs/heads/main",
};
const identity = releaseIdentity(identityEnvironment);
const historicalSoak = JSON.parse(
	await readFile("operations/qualification/node-soak-2026-09-12/full-run.json", "utf8"),
);

test("release identity excludes fork, branch, pull request, zero-build and other-workflow contexts", () => {
	assert.equal(identity.commit, "a".repeat(40));
	for (const change of [
		{ GITHUB_REPOSITORY_ID: "999" },
		{ GITHUB_REPOSITORY_OWNER_ID: "999" },
		{ GITHUB_REPOSITORY: "elsewhere/LexCerta" },
		{ GITHUB_REF: "refs/heads/topic" },
		{ GITHUB_EVENT_NAME: "pull_request_target" },
		{ GITHUB_SHA: "0".repeat(40) },
		{ GITHUB_WORKFLOW_REF: "rubixhacker/LexCerta/.github/workflows/other.yml@refs/heads/main" },
		{ GITHUB_RUN_ATTEMPT: "0" },
	])
		assert.throws(() => releaseIdentity({ ...identityEnvironment, ...change }));
});

test("only a complete non-smoke soak of the selected image can back a candidate", () => {
	validateSoak(historicalSoak, historicalSoak.image);
	for (const change of [
		{ smoke: true },
		{ qualified: false },
		{ phase: "setup" },
		{ failure: {} },
		{ image: `sha256:${"f".repeat(64)}` },
		{ container_runs: [] },
		{ scenarios: [] },
		{ measurements: { ...historicalSoak.measurements, workload_ms: 30_000 } },
		{ measurements: { ...historicalSoak.measurements, peak_client_in_flight: 1 } },
	])
		assert.throws(() => validateSoak({ ...historicalSoak, ...change }, historicalSoak.image));
});

async function withCandidate(operation) {
	const directory = await mkdtemp(join(tmpdir(), "lexcerta-release-artifact-"));
	try {
		for (const file of candidateFiles)
			await writeFile(
				join(directory, file),
				file === "soak.json" ? JSON.stringify(historicalSoak) : `synthetic artifact bytes: ${file}`,
			);
		const record = Candidate.parse({
			version: 1,
			stage: "fixture_qualified",
			identity,
			image_id: historicalSoak.image,
			node: "24.21.0",
			architecture: "amd64",
			created_at: new Date().toISOString(),
			files: Object.fromEntries(
				await Promise.all(
					candidateFiles.map(async (file) => [file, await hashFile(join(directory, file))]),
				),
			),
			compiled_sha256: historicalSoak.compiled_sha256,
			migrations_sha256: { "0001_authority.sql": "b".repeat(64) },
			source_sha256: { Dockerfile: "c".repeat(64) },
		});
		await writeFile(join(directory, "candidate.json"), JSON.stringify(record));
		await operation(directory, record);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test("artifact verification binds every saved file to the exact workflow run and attempt", async () =>
	withCandidate(async (directory, record) => {
		assert.deepEqual(await verifyCandidate(directory, identity), record);
		for (const changed of [
			{ ...identity, commit: "b".repeat(40) },
			{ ...identity, run_id: "123456790" },
			{ ...identity, run_attempt: "2" },
		])
			await assert.rejects(verifyCandidate(directory, changed));
	}));

test("changed image or evidence bytes are rejected before the artifact can be consumed", async () =>
	withCandidate(async (directory) => {
		for (const file of ["runtime.tar", "postgres.log", "soak.json"]) {
			const path = join(directory, file);
			const original = await readFile(path);
			await writeFile(path, "changed-after-qualification");
			await assert.rejects(verifyCandidate(directory, identity));
			await writeFile(path, original);
		}
	}));

test("missing artifacts, symlinks and manifest path traversal are refused", async () =>
	withCandidate(async (directory, record) => {
		await rm(join(directory, "runtime.tar"));
		await assert.rejects(verifyCandidate(directory, identity));
		await symlink(join(directory, "postgres.log"), join(directory, "runtime.tar"));
		await assert.rejects(verifyCandidate(directory, identity));
		assert.throws(() =>
			Candidate.parse({ ...record, files: { ...record.files, "../unexpected": "a".repeat(64) } }),
		);
	}));

test("a manifest cannot relabel fixture evidence as staging or production qualification", async () =>
	withCandidate(async (_directory, record) => {
		for (const stage of ["staging_qualified", "production_approved"])
			assert.throws(() => Candidate.parse({ ...record, stage }));
		assert.throws(() => Candidate.parse({ ...record, approved: true }));
	}));

test("manifest compiled hashes must match those measured by its soak", async () =>
	withCandidate(async (directory, record) => {
		const modified = structuredClone(record);
		modified.compiled_sha256[Object.keys(modified.compiled_sha256)[0]] = "d".repeat(64);
		await writeFile(join(directory, "candidate.json"), JSON.stringify(modified));
		await assert.rejects(verifyCandidate(directory, identity));
	}));

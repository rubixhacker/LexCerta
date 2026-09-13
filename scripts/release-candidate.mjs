import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { RELEASE_REPOSITORY } from "./release-readiness.mjs";

const sha = z
	.string()
	.regex(/^[a-f0-9]{40}$/)
	.refine((value) => value !== "0".repeat(40));
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const decimal = z.string().regex(/^[1-9][0-9]{0,15}$/);
export const candidateFiles = [
	"runtime.tar",
	"repository.log",
	"postgres.log",
	"container.log",
	"audit.log",
	"soak.json",
	"soak.json.container.log",
];
export const candidateFileLimits = Object.freeze({
	"candidate.json": 4_194_304,
	...Object.fromEntries(
		candidateFiles.map((file) => [file, file === "runtime.tar" ? 2_147_483_648 : 67_108_864]),
	),
});
const Identity = z
	.object({
		repository: z.literal(RELEASE_REPOSITORY),
		repository_id: z.literal("1157346206"),
		owner_id: z.literal("1776138"),
		commit: sha,
		run_id: decimal,
		run_attempt: decimal,
		workflow: z.literal(`${RELEASE_REPOSITORY}/.github/workflows/release.yml@refs/heads/main`),
	})
	.strict();
export { Identity as CandidateIdentity };
export const Candidate = z
	.object({
		version: z.literal(1),
		stage: z.literal("fixture_qualified"),
		identity: Identity,
		image_id: z.string().regex(/^sha256:[a-f0-9]{64}$/),
		node: z.literal("24.21.0"),
		architecture: z.literal("amd64"),
		files: z.record(z.enum(candidateFiles), digest),
		compiled_sha256: z.record(z.string().regex(/^[a-z0-9/-]+\.js$/), digest),
		migrations_sha256: z.record(z.string().regex(/^\d{4}_[a-z_]+\.sql$/), digest),
		source_sha256: z.record(z.string(), digest),
		created_at: z.iso.datetime(),
	})
	.strict();

export function releaseIdentity(environment) {
	assert.equal(environment.GITHUB_REF, "refs/heads/main");
	assert.equal(environment.GITHUB_EVENT_NAME, "workflow_dispatch");
	return Identity.parse({
		repository: environment.GITHUB_REPOSITORY,
		repository_id: environment.GITHUB_REPOSITORY_ID,
		owner_id: environment.GITHUB_REPOSITORY_OWNER_ID,
		commit: environment.GITHUB_SHA,
		run_id: environment.GITHUB_RUN_ID,
		run_attempt: environment.GITHUB_RUN_ATTEMPT,
		workflow: environment.GITHUB_WORKFLOW_REF,
	});
}

export async function hashFile(file, { signal } = {}) {
	signal?.throwIfAborted();
	const stat = await lstat(file);
	assert.ok(stat.isFile() && stat.size > 0 && stat.size <= 2_147_483_648, "invalid artifact file");
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(file, { signal })) hash.update(chunk);
	return hash.digest("hex");
}

export function validateSoak(soak, imageId) {
	assert.equal(soak.fixture_only, true);
	assert.equal(soak.smoke, false);
	assert.equal(soak.qualified, true);
	assert.equal(soak.phase, "fixture-soak-passed");
	assert.equal(soak.failure, undefined);
	assert.equal(soak.image, imageId);
	assert.ok(soak.measurements.workload_ms >= 1_800_000);
	assert.ok(soak.measurements.workload_calls > 0);
	assert.equal(soak.measurements.peak_client_in_flight, 8);
	assert.equal(soak.container_runs.length, 2);
	assert.deepEqual(
		soak.container_runs.map((run) => run.restart),
		[false, true],
	);
	for (const run of soak.container_runs) {
		assert.equal(run.cpu, 1);
		assert.equal(run.memory_bytes, 1_073_741_824);
	}
	// The harness evaluates every scenario, sample, quota and shutdown assertion.
	// Retain its full evidence; these checks also reject an incomplete/smoke output.
	for (const name of ["deadline", "abort", "hundred-final", "recovered-after-kill"])
		assert.ok(soak.scenarios.some((scenario) => scenario.name === name));
}

export async function verifyCandidate(directory, expectedIdentity, { signal } = {}) {
	signal?.throwIfAborted();
	assert.deepEqual((await readdir(directory)).sort(), Object.keys(candidateFileLimits).sort());
	for (const [file, limit] of Object.entries(candidateFileLimits)) {
		const stat = await lstat(join(directory, file));
		assert.ok(stat.isFile() && stat.size > 0 && stat.size <= limit, "invalid candidate entry");
	}
	const record = Candidate.parse(
		JSON.parse(await readFile(join(directory, "candidate.json"), { encoding: "utf8", signal })),
	);
	assert.deepEqual(record.identity, Identity.parse(expectedIdentity));
	assert.deepEqual(Object.keys(record.files).sort(), [...candidateFiles].sort());
	for (const file of candidateFiles)
		assert.equal(await hashFile(join(directory, file), { signal }), record.files[file], file);
	const soak = JSON.parse(
		await readFile(join(directory, "soak.json"), { encoding: "utf8", signal }),
	);
	validateSoak(soak, record.image_id);
	assert.deepEqual(soak.compiled_sha256, record.compiled_sha256);
	return record;
}

export async function recordCandidate(directory, environment = process.env) {
	const identity = releaseIdentity(environment);
	const run = async (command, args) =>
		(
			await promisify(execFile)(command, args, {
				timeout: 30_000,
				maxBuffer: 1_048_576,
			})
		).stdout.trim();
	assert.equal(await run("git", ["rev-parse", "HEAD"]), identity.commit);
	assert.equal(
		await run("git", ["status", "--porcelain", "--untracked-files=all"]),
		"",
		"release checkout must be clean",
	);
	const image = JSON.parse(
		await run("docker", ["image", "inspect", environment.LEXCERTA_TEST_IMAGE]),
	)[0];
	assert.equal(image.Architecture, "amd64");
	assert.equal(image.Os, "linux");
	assert.equal(image.Config.User, "node");
	assert.ok(image.Config.Env.includes(`LEXCERTA_BUILD_ID=${identity.commit}`));
	assert.equal(image.Config.Labels["org.opencontainers.image.revision"], identity.commit);
	const soak = JSON.parse(await readFile(join(directory, "soak.json"), "utf8"));
	validateSoak(soak, image.Id);
	const compiled = (await readdir("build", { recursive: true }))
		.filter((file) => file.endsWith(".js"))
		.sort();
	assert.deepEqual(Object.keys(soak.compiled_sha256).sort(), compiled);
	for (const file of compiled)
		assert.equal(await hashFile(join("build", file)), soak.compiled_sha256[file]);
	const migrations = (await readdir("database/migrations"))
		.filter((file) => file.endsWith(".sql"))
		.sort();
	const sources = [
		"Dockerfile",
		"package-lock.json",
		".nvmrc",
		".github/workflows/release.yml",
		"scripts/qualify-node-soak.mjs",
		"scripts/release-candidate.mjs",
	];
	await writeFile(join(directory, "runtime.tar"), "", { flag: "wx" });
	await run("docker", ["image", "save", "--output", join(directory, "runtime.tar"), image.Id]);
	const hashes = async (files, root = ".") =>
		Object.fromEntries(
			await Promise.all(files.map(async (file) => [file, await hashFile(join(root, file))])),
		);
	const record = Candidate.parse({
		version: 1,
		stage: "fixture_qualified",
		identity,
		image_id: image.Id,
		node: "24.21.0",
		architecture: "amd64",
		created_at: new Date().toISOString(),
		files: await hashes(candidateFiles, directory),
		compiled_sha256: soak.compiled_sha256,
		migrations_sha256: await hashes(migrations, "database/migrations"),
		source_sha256: await hashes(sources),
	});
	await writeFile(join(directory, "candidate.json"), `${JSON.stringify(record, null, 2)}\n`, {
		flag: "wx",
	});
	return verifyCandidate(directory, identity);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		assert.equal(process.argv.length, 4);
		assert.equal(process.argv[2], "--output-directory");
		const record = await recordCandidate(process.argv[3]);
		console.log(
			JSON.stringify({
				stage: record.stage,
				commit: record.identity.commit,
				image_id: record.image_id,
			}),
		);
	} catch {
		console.error("Release candidate recording failed; no deployable qualification was recorded");
		process.exitCode = 1;
	}
}

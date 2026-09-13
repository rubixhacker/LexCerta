import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	candidateEntries,
	fixtureIdentity,
	sha256,
	zipFixture,
} from "../test/fixtures/release-archive.mjs";
import { loadCandidateImage } from "./release-image.mjs";
import { prepareCandidate } from "./release-prepare.mjs";

function dockerFixture(candidate, changes = {}) {
	const calls = [];
	const image = {
		Id: candidate.image_id,
		Os: "linux",
		Architecture: "amd64",
		Config: {
			User: "node",
			WorkingDir: "/app",
			Env: [`LEXCERTA_BUILD_ID=${candidate.identity.commit}`],
			Labels: { "org.opencontainers.image.revision": candidate.identity.commit },
			...changes.config,
		},
		...changes.image,
	};
	const actual = {
		node: "24.21.0",
		architecture: "x64",
		uid: 1000,
		build_id: candidate.identity.commit,
		compiled_sha256: candidate.compiled_sha256,
		migrations_sha256: candidate.migrations_sha256,
		...changes.actual,
	};
	const docker = async (args, options) => {
		calls.push(args);
		if (args[0] === "rm") return "";
		assert.ok(options.signal instanceof AbortSignal);
		if (args[1] === "load") return changes.loaded ?? `Loaded image ID: ${candidate.image_id}`;
		if (args[1] === "inspect") return JSON.stringify([image]);
		assert.equal(args[0], "run");
		for (const [flag, value] of [
			["--network", "none"],
			["--entrypoint", "node"],
			["--user", "1000:1000"],
		])
			assert.equal(args[args.indexOf(flag) + 1], value);
		assert.ok(args.includes("--read-only"));
		if (changes.executionError) throw new Error("provider diagnostic with synthetic secret");
		return JSON.stringify(actual);
	};
	return { calls, docker };
}

async function withDirectory(operation) {
	const root = await mkdtemp(join(tmpdir(), "lexcerta-prepare-"));
	try {
		await operation(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

async function unpackFixture(directory) {
	const fixture = await candidateEntries();
	await mkdir(directory);
	for (const { name, bytes } of fixture.entries) await writeFile(join(directory, name), bytes);
	return fixture.candidate;
}

test("loading binds the actual load result and every measured compiled and migration file", async () =>
	withDirectory(async (root) => {
		const directory = join(root, "candidate");
		const candidate = await unpackFixture(directory);
		const fixture = dockerFixture(candidate);
		const result = await loadCandidateImage(directory, fixtureIdentity, fixture);
		assert.equal(result.stage, "image_verified");
		assert.equal(result.image_id, candidate.image_id);
		assert.equal(result.approval_granted, false);
		assert.deepEqual(
			fixture.calls.map((args) => args[0]),
			["image", "image", "run", "rm"],
		);
		assert.equal(fixture.calls[2][fixture.calls[2].indexOf("--name") + 1], fixture.calls[3][2]);
	}));

test("a pre-existing expected image cannot conceal loading a different image or multiple images", async () =>
	withDirectory(async (root) => {
		const directory = join(root, "candidate");
		const candidate = await unpackFixture(directory);
		for (const loaded of [
			`Loaded image ID: sha256:${"b".repeat(64)}`,
			`Loaded image ID: ${candidate.image_id}\nLoaded image ID: sha256:${"b".repeat(64)}`,
			"Loaded image: unrelated:latest",
		]) {
			const fixture = dockerFixture(candidate, { loaded });
			await assert.rejects(loadCandidateImage(directory, fixtureIdentity, fixture), {
				message: "Release candidate image unavailable",
			});
			assert.equal(fixture.calls.length, 1);
		}
	}));

test("wrong image identity, platform, user, build label or executable environment prevents execution", async () =>
	withDirectory(async (root) => {
		const directory = join(root, "candidate");
		const candidate = await unpackFixture(directory);
		for (const change of [
			{ image: { Id: `sha256:${"b".repeat(64)}` } },
			{ image: { Os: "windows" } },
			{ image: { Architecture: "arm64" } },
			{ config: { User: "root" } },
			{ config: { WorkingDir: "/elsewhere" } },
			{ config: { Labels: {} } },
			{
				config: {
					Env: [
						`LEXCERTA_BUILD_ID=${candidate.identity.commit}`,
						"NODE_OPTIONS=--require=untrusted",
					],
				},
			},
			{ config: { Volumes: { "/app": {} } } },
		]) {
			const fixture = dockerFixture(candidate, change);
			await assert.rejects(loadCandidateImage(directory, fixtureIdentity, fixture));
			assert.equal(fixture.calls.length, 2);
		}
	}));

test("changed runtime or migration contents and execution errors fail and clean up the owned container", async () =>
	withDirectory(async (root) => {
		const directory = join(root, "candidate");
		const candidate = await unpackFixture(directory);
		for (const change of [
			{ actual: { node: "26.0.0" } },
			{ actual: { architecture: "arm64" } },
			{ actual: { uid: 0 } },
			{ actual: { build_id: "0".repeat(40) } },
			{ actual: { compiled_sha256: {} } },
			{ actual: { migrations_sha256: {} } },
			{ executionError: true },
		]) {
			const fixture = dockerFixture(candidate, change);
			await assert.rejects(loadCandidateImage(directory, fixtureIdentity, fixture), {
				message: "Release candidate image unavailable",
			});
			assert.equal(fixture.calls.at(-1)[0], "rm");
		}
	}));

test("changed candidate bytes and pre-cancelled requests perform no Docker operations", async () =>
	withDirectory(async (root) => {
		const directory = join(root, "candidate");
		const candidate = await unpackFixture(directory);
		const fixture = dockerFixture(candidate);
		await assert.rejects(
			loadCandidateImage(directory, fixtureIdentity, { ...fixture, signal: AbortSignal.abort() }),
		);
		await writeFile(join(directory, "runtime.tar"), "changed tar");
		await assert.rejects(loadCandidateImage(directory, fixtureIdentity, fixture));
		assert.equal(fixture.calls.length, 0);
	}));

function githubFixture(archive, change = {}) {
	const repo = { id: 1157346206, owner: { id: 1776138 } };
	const run = {
		id: 12345,
		run_attempt: 2,
		path: ".github/workflows/release.yml",
		event: "workflow_dispatch",
		status: "completed",
		conclusion: "success",
		head_branch: "main",
		head_sha: fixtureIdentity.commit,
		repository: repo,
		head_repository: repo,
		...change,
	};
	const artifact = {
		id: 45678,
		name: "lexcerta-candidate-12345-2",
		expired: false,
		size_in_bytes: archive.length,
		digest: `sha256:${sha256(archive)}`,
		workflow_run: {
			id: 12345,
			repository_id: 1157346206,
			head_repository_id: 1157346206,
			head_branch: "main",
			head_sha: fixtureIdentity.commit,
		},
	};
	return async (url) => {
		if (url.endsWith("/runs/12345")) return Response.json(run);
		if (url.endsWith("/artifacts?per_page=100"))
			return Response.json({ total_count: 1, artifacts: [artifact] });
		if (url.endsWith("/artifacts/45678")) return Response.json(artifact);
		if (url.endsWith("/zip"))
			return new Response(null, {
				status: 302,
				headers: { location: "https://archive.example.test/candidate.zip" },
			});
		assert.equal(url, "https://archive.example.test/candidate.zip");
		return new Response(archive);
	};
}

test("prepare connects actual archive parsing and candidate verification to image verification", async () =>
	withDirectory(async (root) => {
		const { entries, candidate } = await candidateEntries();
		const archive = zipFixture(entries);
		const directory = join(root, "prepared");
		const fixture = dockerFixture(candidate);
		const result = await prepareCandidate(fixtureIdentity, directory, {
			...fixture,
			request: githubFixture(archive),
		});
		assert.equal(result.archive_sha256, sha256(archive));
		assert.equal(result.stage, "image_verified");
		assert.equal(result.approval_granted, false);
		assert.deepEqual(JSON.parse(await readFile(join(directory, "handoff.json"), "utf8")), result);
		assert.deepEqual(await readFile(join(directory, "candidate.zip")), archive);
	}));

test("prepare failures leave no successful handoff or partial work and preserve existing directories", async () =>
	withDirectory(async (root) => {
		const { entries, candidate } = await candidateEntries();
		const directory = join(root, "prepared");
		const archives = [
			zipFixture(entries),
			zipFixture(
				entries.map((entry) =>
					entry.name === "runtime.tar" ? { ...entry, bytes: Buffer.from("tampered") } : entry,
				),
			),
		];
		for (const options of [
			{ request: githubFixture(archives[0], { conclusion: "failure" }) },
			{ request: githubFixture(archives[1]) },
			{
				request: githubFixture(archives[0]),
				...dockerFixture(candidate, { executionError: true }),
			},
		]) {
			await assert.rejects(
				prepareCandidate(fixtureIdentity, directory, { ...dockerFixture(candidate), ...options }),
				{ message: "Release candidate preparation unavailable" },
			);
			await assert.rejects(access(directory), { code: "ENOENT" });
		}
		await mkdir(directory);
		await writeFile(join(directory, "keep"), "preserved");
		await assert.rejects(prepareCandidate(fixtureIdentity, directory, {}));
		assert.equal(await readFile(join(directory, "keep"), "utf8"), "preserved");
	}));

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { downloadCandidateArchive, inspectCandidateOrigin } from "./release-download.mjs";
import { readGitHubReleaseJson, repositoryApiUrl } from "./release-github.mjs";

const identity = {
	repository: "rubixhacker/LexCerta",
	repository_id: "1157346206",
	owner_id: "1776138",
	commit: "a".repeat(40),
	run_id: "12345",
	run_attempt: "2",
	workflow: "rubixhacker/LexCerta/.github/workflows/release.yml@refs/heads/main",
};
const bytes = Buffer.from("synthetic archive bytes, not a qualified runtime image");
const sha = (value) => createHash("sha256").update(value).digest("hex");
function fixture(options = {}) {
	const repository = { id: 1157346206, owner: { id: 1776138 } };
	const run = {
		id: 12345,
		run_attempt: 2,
		path: ".github/workflows/release.yml",
		event: "workflow_dispatch",
		status: "completed",
		conclusion: "success",
		head_branch: "main",
		head_sha: identity.commit,
		repository,
		head_repository: repository,
		...options.run,
	};
	const artifact = {
		id: 45678,
		name: "lexcerta-candidate-12345-2",
		expired: false,
		size_in_bytes: bytes.length,
		digest: `sha256:${sha(bytes)}`,
		workflow_run: {
			id: 12345,
			repository_id: 1157346206,
			head_repository_id: 1157346206,
			head_branch: "main",
			head_sha: identity.commit,
		},
		...options.artifact,
	};
	const calls = [];
	let runReads = 0;
	const request = async (url, init) => {
		calls.push(url);
		assert.equal(init.method, "GET");
		assert.ok(init.signal instanceof AbortSignal);
		if (url.startsWith("https://artifacts.example.test/")) {
			assert.equal(init.headers, undefined);
			assert.equal(init.credentials, "omit");
			assert.equal(init.redirect, "error");
			return new Response(options.stream ?? options.downloadBytes ?? bytes);
		}
		assert.equal(init.headers.Authorization, "Bearer synthetic-github-token");
		assert.ok(url.startsWith("https://api.github.com/repos/rubixhacker/LexCerta/"));
		if (url.endsWith("/zip")) {
			assert.equal(init.redirect, "manual");
			return new Response(null, {
				status: 302,
				headers: {
					location:
						options.location ??
						"https://artifacts.example.test/candidate.zip?signature=private-signed-url",
				},
			});
		}
		assert.equal(init.redirect, "error");
		if (url.endsWith("/runs/12345"))
			return Response.json(runReads++ ? { ...run, ...options.afterRun } : run);
		if (url.includes("/artifacts?"))
			return Response.json(options.listing ?? { total_count: 1, artifacts: [artifact] });
		if (url.endsWith("/artifacts/45678"))
			return Response.json({ ...artifact, ...options.currentArtifact });
		throw new Error("unexpected fixture route");
	};
	return { request, calls, token: "synthetic-github-token" };
}
async function withOutput(operation) {
	const directory = await mkdtemp(join(tmpdir(), "lexcerta-candidate-download-"));
	try {
		await operation(join(directory, "candidate.zip"));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test("candidate origin binds a completed main release workflow and exact artifact metadata", async () => {
	const source = fixture();
	assert.deepEqual(await inspectCandidateOrigin(identity, source), {
		identity,
		artifact_id: "45678",
		archive_sha256: sha(bytes),
		archive_bytes: bytes.length,
	});
	assert.equal(source.calls.length, 3);
});

test("failed, active, rerun, foreign, PR and different-workflow sources fail before artifact listing", async () => {
	for (const run of [
		{ conclusion: "failure" },
		{ status: "in_progress" },
		{ run_attempt: 3 },
		{ path: ".github/workflows/check.yml" },
		{ event: "pull_request" },
		{ head_branch: "topic" },
		{ head_sha: "b".repeat(40) },
		{ head_repository: { id: 999, owner: { id: 1776138 } } },
		{ repository: { id: 1157346206, owner: { id: 999 } } },
	]) {
		const source = fixture({ run });
		await assert.rejects(inspectCandidateOrigin(identity, source), {
			message: "Release candidate origin unavailable",
		});
		assert.equal(source.calls.length, 1);
	}
});

test("ambiguous, expired, replaced and cross-run artifacts cannot acquire trusted origin", async () => {
	for (const options of [
		{ listing: { total_count: 0, artifacts: [] } },
		{ listing: { total_count: 101, artifacts: [] } },
		{
			listing: {
				total_count: 2,
				artifacts: [{ name: "lexcerta-candidate-12345-2" }, { name: "lexcerta-candidate-12345-2" }],
			},
		},
		{ artifact: { expired: true } },
		{ artifact: { digest: null } },
		{ artifact: { size_in_bytes: 2_147_483_649 } },
		{ artifact: { workflow_run: { id: 999 } } },
		{ currentArtifact: { digest: `sha256:${"b".repeat(64)}` } },
		{ currentArtifact: { size_in_bytes: bytes.length + 1 } },
	])
		await assert.rejects(inspectCandidateOrigin(identity, fixture(options)), {
			message: "Release candidate origin unavailable",
		});
});

test("download writes only bytes matching GitHub's archive digest and omits API credentials on the signed URL", async () =>
	withOutput(async (output) => {
		const source = fixture();
		const result = await downloadCandidateArchive(identity, output, source);
		assert.deepEqual(await readFile(output), bytes);
		assert.equal(result.stage, "download_verified");
		assert.equal(result.approval_granted, false);
		assert.ok(!JSON.stringify(result).includes("synthetic-github-token"));
		assert.ok(!JSON.stringify(result).includes("private-signed-url"));
		assert.equal(source.calls.filter((url) => url.endsWith("/runs/12345")).length, 2);
	}));

test("wrong, truncated and oversized archives are deleted and never returned as verified", async () => {
	for (const downloadBytes of [
		Buffer.alloc(bytes.length, 65),
		bytes.subarray(1),
		Buffer.concat([bytes, Buffer.from("extra")]),
	])
		await withOutput(async (output) => {
			await assert.rejects(downloadCandidateArchive(identity, output, fixture({ downloadBytes })), {
				message: "Release candidate download unavailable",
			});
			await assert.rejects(access(output), { code: "ENOENT" });
		});
});

test("a rerun starting while bytes download invalidates the handoff and removes the archive", async () =>
	withOutput(async (output) => {
		await assert.rejects(
			downloadCandidateArchive(
				identity,
				output,
				fixture({ afterRun: { status: "in_progress", conclusion: null, run_attempt: 3 } }),
			),
			{ message: "Release candidate download unavailable" },
		);
		await assert.rejects(access(output), { code: "ENOENT" });
	}));

test("an existing output is preserved and unsafe signed URLs never receive a request", async () => {
	await withOutput(async (output) => {
		await writeFile(output, "keep existing evidence");
		await assert.rejects(downloadCandidateArchive(identity, output, fixture()));
		assert.equal(await readFile(output, "utf8"), "keep existing evidence");
	});
	for (const location of [
		"http://artifacts.example.test/file",
		"https://user:password@artifacts.example.test/file",
		"https://artifacts.example.test:444/file",
		"file:///private/tmp/anything",
	])
		await withOutput(async (output) => {
			const source = fixture({ location });
			await assert.rejects(downloadCandidateArchive(identity, output, source));
			assert.equal(source.calls.length, 4);
			await assert.rejects(access(output), { code: "ENOENT" });
		});
});

test("cancelling a stalled archive stream closes it and removes partial bytes", async () =>
	withOutput(async (output) => {
		let closed = false;
		const controller = new AbortController();
		const source = fixture({
			stream: new ReadableStream({
				start(stream) {
					stream.enqueue(bytes.subarray(0, 3));
				},
				cancel() {
					closed = true;
				},
			}),
		});
		const timer = setTimeout(() => controller.abort(), 50);
		try {
			await assert.rejects(
				downloadCandidateArchive(identity, output, { ...source, signal: controller.signal }),
				{ message: "Release candidate download unavailable" },
			);
			assert.equal(closed, true);
			await assert.rejects(access(output), { code: "ENOENT" });
		} finally {
			clearTimeout(timer);
		}
	}));

test("release API reads reject other repositories, arbitrary routes, malformed data and token header injection", async () => {
	for (const path of [
		"../../another/repository",
		"actions/runs/0",
		"actions/artifacts/1/zip?redirect=elsewhere",
		"issues/1",
	])
		assert.throws(() => repositoryApiUrl(path));
	for (const response of [
		new Response("provider-private", { status: 403 }),
		new Response("provider-private"),
		new Response("x".repeat(262_145)),
	])
		await assert.rejects(
			readGitHubReleaseJson("actions/runs/1", { request: async () => response }),
			{ message: "GitHub release evidence unavailable" },
		);
	let calls = 0;
	await assert.rejects(
		readGitHubReleaseJson("actions/runs/1", {
			token: "bad\nheader",
			request: async () => {
				calls++;
			},
		}),
	);
	assert.equal(calls, 0);
});

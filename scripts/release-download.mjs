import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { open, rm } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { CandidateIdentity } from "./release-candidate.mjs";
import {
	RELEASE_REPOSITORY,
	githubHeaders,
	readGitHubReleaseJson,
	repositoryApiUrl,
} from "./release-github.mjs";

const MAX_ARCHIVE_BYTES = 2_147_483_648;

function assertRun(run, identity) {
	assert.ok(Number.isSafeInteger(run?.id));
	assert.equal(String(run.id), identity.run_id);
	assert.equal(String(run.run_attempt), identity.run_attempt);
	assert.equal(run.path, ".github/workflows/release.yml");
	assert.equal(run.event, "workflow_dispatch");
	assert.equal(run.status, "completed");
	assert.equal(run.conclusion, "success");
	assert.equal(run.head_branch, "main");
	assert.equal(run.head_sha, identity.commit);
	for (const repository of [run.repository, run.head_repository]) {
		assert.equal(String(repository?.id), identity.repository_id);
		assert.equal(String(repository?.owner?.id), identity.owner_id);
	}
}

function assertArtifact(artifact, identity) {
	assert.ok(Number.isSafeInteger(artifact?.id) && artifact.id > 0);
	assert.equal(artifact.name, `lexcerta-candidate-${identity.run_id}-${identity.run_attempt}`);
	assert.equal(artifact.expired, false);
	assert.match(artifact.digest, /^sha256:[a-f0-9]{64}$/);
	assert.ok(
		Number.isSafeInteger(artifact.size_in_bytes) &&
			artifact.size_in_bytes > 0 &&
			artifact.size_in_bytes <= MAX_ARCHIVE_BYTES,
	);
	assert.equal(String(artifact.workflow_run?.id), identity.run_id);
	assert.equal(String(artifact.workflow_run?.repository_id), identity.repository_id);
	assert.equal(String(artifact.workflow_run?.head_repository_id), identity.repository_id);
	assert.equal(artifact.workflow_run?.head_branch, "main");
	assert.equal(artifact.workflow_run?.head_sha, identity.commit);
}

export async function inspectCandidateOrigin(expectedIdentity, connection = {}) {
	try {
		const identity = CandidateIdentity.parse(expectedIdentity);
		const read = (path) => readGitHubReleaseJson(path, connection);
		assertRun(await read(`actions/runs/${identity.run_id}`), identity);
		const listing = await read(`actions/runs/${identity.run_id}/artifacts?per_page=100`);
		assert.ok(
			Number.isInteger(listing?.total_count) &&
				listing.total_count >= 1 &&
				listing.total_count <= 100,
		);
		assert.equal(listing.artifacts?.length, listing.total_count);
		const matching = listing.artifacts.filter(
			(artifact) =>
				artifact.name === `lexcerta-candidate-${identity.run_id}-${identity.run_attempt}`,
		);
		assert.equal(matching.length, 1);
		const listed = matching[0];
		assertArtifact(listed, identity);
		const current = await read(`actions/artifacts/${listed.id}`);
		assertArtifact(current, identity);
		assert.equal(current.id, listed.id);
		assert.equal(current.digest, listed.digest);
		assert.equal(current.size_in_bytes, listed.size_in_bytes);
		return {
			identity,
			artifact_id: String(current.id),
			archive_sha256: current.digest.slice(7),
			archive_bytes: current.size_in_bytes,
		};
	} catch {
		throw new Error("Release candidate origin unavailable");
	}
}

// The zip is verified before callers may extract or load anything. A signed
// download URL receives no GitHub token, cookies, or caller-supplied headers.
export async function downloadCandidateArchive(expectedIdentity, outputPath, options = {}) {
	let file;
	let created = false;
	let responseBody;
	const controller = new AbortController();
	const timeoutMs = options.timeoutMs ?? 180_000;
	assert.ok(Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 180_000);
	const timeout = AbortSignal.timeout(timeoutMs);
	const signal = AbortSignal.any([
		timeout,
		controller.signal,
		...(options.signal ? [options.signal] : []),
	]);
	const connection = { token: options.token, request: options.request ?? fetch, signal };
	try {
		const origin = await inspectCandidateOrigin(expectedIdentity, connection);
		signal.throwIfAborted();
		const redirect = await connection.request(
			repositoryApiUrl(`actions/artifacts/${origin.artifact_id}/zip`),
			{
				method: "GET",
				redirect: "manual",
				signal,
				headers: githubHeaders(options.token),
			},
		);
		void redirect.body?.cancel().catch(() => undefined);
		assert.equal(redirect.status, 302);
		const location = redirect.headers.get("location");
		assert.ok(location && location.length <= 8192);
		const url = new URL(location);
		assert.equal(url.protocol, "https:");
		assert.equal(url.username, "");
		assert.equal(url.password, "");
		assert.equal(url.hash, "");
		assert.ok(url.port === "" || url.port === "443");
		const response = await connection.request(url.href, {
			method: "GET",
			redirect: "error",
			credentials: "omit",
			signal,
		});
		responseBody = response.body;
		if (!response.ok || !response.body) {
			void response.body?.cancel().catch(() => undefined);
			throw new Error();
		}
		file = await open(outputPath, "wx", 0o600);
		created = true;
		const hash = createHash("sha256");
		let bytes = 0;
		const validate = new Transform({
			transform(chunk, _encoding, callback) {
				bytes += chunk.length;
				if (bytes > origin.archive_bytes) {
					callback(new Error("Artifact size mismatch"));
					return;
				}
				hash.update(chunk);
				callback(null, chunk);
			},
		});
		await pipeline(Readable.fromWeb(response.body), validate, file.createWriteStream(), { signal });
		assert.equal(bytes, origin.archive_bytes);
		assert.equal(hash.digest("hex"), origin.archive_sha256);
		await file.close();
		file = undefined;
		assertRun(
			await readGitHubReleaseJson(`actions/runs/${origin.identity.run_id}`, connection),
			origin.identity,
		);
		return { ...origin, stage: "download_verified", approval_granted: false };
	} catch {
		await file?.close().catch(() => undefined);
		if (created) await rm(outputPath, { force: true });
		throw new Error("Release candidate download unavailable");
	} finally {
		controller.abort();
		void responseBody?.cancel().catch(() => undefined);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		const args = process.argv.slice(2);
		assert.deepEqual(
			args.filter((_arg, index) => index % 2 === 0),
			["--run-id", "--run-attempt", "--commit", "--output"],
		);
		assert.equal(args.length, 8);
		const identity = {
			repository: RELEASE_REPOSITORY,
			repository_id: "1157346206",
			owner_id: "1776138",
			run_id: args[1],
			run_attempt: args[3],
			commit: args[5],
			workflow: `${RELEASE_REPOSITORY}/.github/workflows/release.yml@refs/heads/main`,
		};
		console.log(
			JSON.stringify(
				await downloadCandidateArchive(identity, args[7], { token: process.env.GH_TOKEN }),
			),
		);
	} catch {
		console.error("Release candidate download unavailable");
		process.exitCode = 1;
	}
}

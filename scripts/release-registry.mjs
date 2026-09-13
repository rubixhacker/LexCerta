import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { verifyCandidate } from "./release-candidate.mjs";

const HOST = "us-central1-docker.pkg.dev";
const DIGEST = /^sha256:[a-f0-9]{64}$/;
export const CRANE_VERSION = "0.22.1";

export function stagingRepository(projectId) {
	assert.match(projectId, /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/);
	return {
		resource: `projects/${projectId}/locations/us-central1/repositories/lexcerta`,
		image: `${HOST}/${projectId}/lexcerta/runtime`,
	};
}

async function runCommand(binary, args, options) {
	return (
		await promisify(execFile)(binary, args, {
			...options,
			encoding: "buffer",
			maxBuffer: 1_048_576,
		})
	).stdout;
}

async function readArtifactResource(resource, { accessToken, request, signal }) {
	const abort = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
	let reader;
	try {
		abort.throwIfAborted();
		const response = await request(`https://artifactregistry.googleapis.com/v1/${resource}`, {
			method: "GET",
			redirect: "error",
			signal: abort,
			headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
		});
		if (response.status === 404) {
			void response.body?.cancel().catch(() => undefined);
			return null;
		}
		if (response.status !== 200 || !response.body) {
			void response.body?.cancel().catch(() => undefined);
			throw new Error();
		}
		reader = response.body.getReader();
		const chunks = [];
		let bytes = 0;
		for (;;) {
			abort.throwIfAborted();
			const part = await reader.read();
			if (part.done) break;
			bytes += part.value.length;
			assert.ok(bytes <= 262_144);
			chunks.push(part.value);
		}
		abort.throwIfAborted();
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} finally {
		void reader?.cancel().catch(() => undefined);
	}
}

// Call only with the in-process result of prepareCandidate. The CLI always
// establishes fresh GitHub origin and protection before entering this function.
export async function publishStagingCandidate(
	directory,
	prepared,
	projectId,
	{ accessToken, request = fetch, command = runCommand, crane = "crane", signal } = {},
) {
	const abort = AbortSignal.any([AbortSignal.timeout(600_000), ...(signal ? [signal] : [])]);
	let credentials;
	try {
		abort.throwIfAborted();
		const target = stagingRepository(projectId);
		assert.match(accessToken, /^[\x21-\x7e]{20,4096}$/);
		assert.equal(prepared.stage, "image_verified");
		assert.equal(prepared.approval_granted, false);
		assert.match(prepared.artifact_id, /^[1-9][0-9]{0,15}$/);
		assert.match(prepared.archive_sha256, /^[a-f0-9]{64}$/);
		const candidate = await verifyCandidate(directory, prepared.identity, { signal: abort });
		assert.equal(prepared.image_id, candidate.image_id);
		assert.deepEqual(prepared.compiled_sha256, candidate.compiled_sha256);
		assert.deepEqual(prepared.migrations_sha256, candidate.migrations_sha256);
		const read = (resource) =>
			readArtifactResource(resource, { accessToken, request, signal: abort });
		const repository = await read(target.resource);
		assert.equal(repository?.name, target.resource);
		assert.equal(repository.format, "DOCKER");
		assert.equal(repository.mode, "STANDARD_REPOSITORY");
		assert.equal(repository.labels?.application, "lexcerta");
		assert.equal(repository.labels?.environment, "staging");
		assert.equal(repository.dockerConfig?.immutableTags, true);
		const tag = `candidate-${candidate.identity.commit}-${candidate.identity.run_id}-${candidate.identity.run_attempt}`;
		const tagResource = `${target.resource}/packages/runtime/tags/${tag}`;
		const tagged = `${target.image}:${tag}`;
		const prior = await read(tagResource);
		credentials = await mkdtemp(join(tmpdir(), "lexcerta-registry-auth-"));
		await writeFile(
			join(credentials, "config.json"),
			JSON.stringify({
				auths: {
					[HOST]: { auth: Buffer.from(`oauth2accesstoken:${accessToken}`).toString("base64") },
				},
			}),
			{ mode: 0o600, flag: "wx" },
		);
		const run = (binary, args, timeout = 30_000) =>
			command(binary, args, {
				timeout,
				signal: abort,
				env: { ...process.env, DOCKER_CONFIG: credentials },
			});
		const text = (value) => Buffer.from(value).toString("utf8").trim();
		assert.equal(text(await run(crane, ["version"])), CRANE_VERSION);
		if (!prior) {
			await run("docker", ["image", "tag", candidate.image_id, tagged]);
			await run("docker", ["image", "push", tagged], 180_000);
		}
		const published = await read(tagResource);
		assert.equal(published?.name, tagResource);
		const versionPrefix = `${target.resource}/packages/runtime/versions/`;
		assert.ok(published.version.startsWith(versionPrefix));
		const digest = published.version.slice(versionPrefix.length);
		assert.match(digest, DIGEST);
		if (prior) assert.deepEqual(published, prior);
		const reference = `${target.image}@${digest}`;
		assert.equal(text(await run(crane, ["digest", tagged])), digest);
		const manifest = Buffer.from(await run(crane, ["manifest", reference]));
		assert.equal(`sha256:${createHash("sha256").update(manifest).digest("hex")}`, digest);
		const manifestDocument = JSON.parse(manifest.toString("utf8"));
		assert.equal(manifestDocument.schemaVersion, 2);
		assert.ok(
			[
				"application/vnd.oci.image.index.v1+json",
				"application/vnd.oci.image.manifest.v1+json",
				"application/vnd.docker.distribution.manifest.list.v2+json",
				"application/vnd.docker.distribution.manifest.v2+json",
			].includes(manifestDocument.mediaType),
		);
		await run(crane, ["validate", "--remote", reference], 180_000);
		await run("docker", ["image", "pull", reference], 180_000);
		const inspected = JSON.parse(text(await run("docker", ["image", "inspect", reference])));
		assert.equal(inspected.length, 1);
		assert.equal(inspected[0].Id, candidate.image_id);
		assert.ok(inspected[0].RepoDigests.includes(reference));
		assert.equal(inspected[0].Architecture, "amd64");
		assert.equal(inspected[0].Os, "linux");
		abort.throwIfAborted();
		return {
			stage: "staging_image_published",
			environment: "staging",
			project_id: projectId,
			identity: candidate.identity,
			image_id: candidate.image_id,
			image_reference: reference,
			registry_digest: digest,
			registry_media_type: manifestDocument.mediaType,
			artifact_id: prepared.artifact_id,
			archive_sha256: prepared.archive_sha256,
			compiled_sha256: candidate.compiled_sha256,
			migrations_sha256: candidate.migrations_sha256,
			reused_existing_tag: prior !== null,
			approval_granted: false,
		};
	} catch {
		throw new Error("Staging image publication unavailable");
	} finally {
		if (credentials) await rm(credentials, { recursive: true, force: true });
	}
}

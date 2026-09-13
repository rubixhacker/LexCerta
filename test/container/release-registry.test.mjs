import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { loadCandidateImage } from "../../scripts/release-image.mjs";
import { publishStagingCandidate, stagingRepository } from "../../scripts/release-registry.mjs";
import { saveImageFixture } from "../fixtures/release-saved-image.mjs";
import { docker, image, until } from "./runtime-fixture.mjs";

test("actual registry publication preserves the prepared image and a retry reuses the verified digest", async (context) => {
	const root = await mkdtemp(join(tmpdir(), "lexcerta-registry-container-"));
	const registry = `lexcerta-registry-${randomUUID()}`;
	const target = stagingRepository("lexcerta-fixture");
	let local;
	let localTag;
	let localDigest;
	try {
		await docker(
			"run",
			"--detach",
			"--rm",
			"--name",
			registry,
			"--publish",
			"127.0.0.1::5000",
			"--memory",
			"256m",
			"--cpus",
			"1",
			"registry@sha256:1be55279f18a2fe1a74edf2664cac61c1bea305b7b4642dab412e7affdcb3e33",
		);
		const registryState = JSON.parse(await docker("inspect", registry))[0];
		const port = registryState.NetworkSettings.Ports["5000/tcp"][0].HostPort;
		const origin = `http://127.0.0.1:${port}`;
		local = `127.0.0.1:${port}/lexcerta-fixture/lexcerta/runtime`;
		await until(async () =>
			fetch(`${origin}/v2/`).then(
				(response) => response.ok,
				() => false,
			),
		);
		const directory = join(root, "candidate");
		const candidate = await saveImageFixture(directory, image, docker);
		const checked = await loadCandidateImage(directory, candidate.identity, {
			docker: (args) => docker(...args),
		});
		const prepared = { ...checked, artifact_id: "45678", archive_sha256: "a".repeat(64) };
		let pushes = 0;
		const command = async (binary, args, options) => {
			const mapped = args.map((arg) => arg.replaceAll(target.image, local));
			const isDocker = binary === "docker";
			if (isDocker && args[1] === "push") {
				pushes++;
				localTag = mapped[2];
			}
			const commandArgs = isDocker
				? [
						...(process.env.LEXCERTA_TEST_DOCKER_HOST
							? ["--host", process.env.LEXCERTA_TEST_DOCKER_HOST]
							: []),
						...mapped,
					]
				: [...mapped, ...(args[0] === "version" ? [] : ["--insecure"])];
			let result;
			try {
				result = await promisify(execFile)(
					isDocker ? binary : (process.env.LEXCERTA_CRANE ?? "crane"),
					commandArgs,
					{ ...options, encoding: "buffer", maxBuffer: 1_048_576 },
				);
			} catch (error) {
				context.diagnostic(
					`Local registry fixture ${binary} ${args.slice(0, 2).join(" ")}: ${String(error.stderr ?? error.message).slice(0, 4096)}`,
				);
				throw error;
			}
			// Only adapt the test registry address; image bytes and digests are real.
			return isDocker && args[1] === "inspect"
				? Buffer.from(result.stdout.toString().replaceAll(local, target.image))
				: result.stdout;
		};
		const request = async (url, options) => {
			assert.equal(options.headers.Authorization, "Bearer synthetic-registry-fixture-token");
			if (url === `https://artifactregistry.googleapis.com/v1/${target.resource}`)
				return Response.json({
					name: target.resource,
					format: "DOCKER",
					mode: "STANDARD_REPOSITORY",
					labels: { application: "lexcerta", environment: "staging" },
					dockerConfig: { immutableTags: true },
				});
			const prefix = `https://artifactregistry.googleapis.com/v1/${target.resource}/packages/runtime/tags/`;
			assert.ok(url.startsWith(prefix));
			const tag = url.slice(prefix.length);
			const response = await fetch(
				`${origin}/v2/lexcerta-fixture/lexcerta/runtime/manifests/${tag}`,
				{
					signal: options.signal,
					headers: {
						Accept:
							"application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json",
					},
				},
			);
			void response.body?.cancel().catch(() => undefined);
			if (response.status === 404) return new Response(null, { status: 404 });
			assert.equal(response.status, 200);
			const digest = response.headers.get("docker-content-digest");
			localDigest = `${local}@${digest}`;
			return Response.json({
				name: `${target.resource}/packages/runtime/tags/${tag}`,
				version: `${target.resource}/packages/runtime/versions/${digest}`,
			});
		};
		const connection = { accessToken: "synthetic-registry-fixture-token", request, command };
		const published = await publishStagingCandidate(
			directory,
			prepared,
			"lexcerta-fixture",
			connection,
		);
		assert.equal(published.image_id, candidate.image_id);
		assert.equal(published.reused_existing_tag, false);
		const repeated = await publishStagingCandidate(
			directory,
			prepared,
			"lexcerta-fixture",
			connection,
		);
		assert.equal(repeated.registry_digest, published.registry_digest);
		assert.equal(repeated.reused_existing_tag, true);
		assert.equal(pushes, 1);
		assert.equal(repeated.approval_granted, false);
		context.diagnostic(
			JSON.stringify({
				fixture_only: true,
				registry: "local CNCF distribution",
				google_metadata: "synthetic",
				immutable_tag_policy: "synthetic preflight only",
				image_id: candidate.image_id,
				registry_digest: published.registry_digest,
				media_type: published.registry_media_type,
				pushes,
				retry_reused_digest: true,
			}),
		);
	} finally {
		if (localTag) await docker("image", "rm", localTag).catch(() => undefined);
		if (localDigest) await docker("image", "rm", localDigest).catch(() => undefined);
		await docker("rm", "--force", registry).catch(() => undefined);
		await rm(root, { recursive: true, force: true });
	}
});

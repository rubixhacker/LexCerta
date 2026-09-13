import assert from "node:assert/strict";
import { access, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { candidateEntries, sha256 } from "../test/fixtures/release-archive.mjs";
import { publishStagingCandidate, stagingRepository } from "./release-registry.mjs";

const project = "lexcerta-fixture";
const target = stagingRepository(project);
const token = "synthetic-google-access-token";
const manifest = Buffer.from(
	JSON.stringify({
		schemaVersion: 2,
		mediaType: "application/vnd.oci.image.index.v1+json",
		manifests: [],
	}),
);
const digest = `sha256:${sha256(manifest)}`;

async function withCandidate(operation) {
	const root = await mkdtemp(join(tmpdir(), "lexcerta-registry-test-"));
	try {
		const directory = join(root, "candidate");
		await mkdir(directory);
		const { entries, candidate } = await candidateEntries();
		for (const entry of entries) await writeFile(join(directory, entry.name), entry.bytes);
		const prepared = {
			stage: "image_verified",
			identity: candidate.identity,
			image_id: candidate.image_id,
			compiled_sha256: candidate.compiled_sha256,
			migrations_sha256: candidate.migrations_sha256,
			artifact_id: "45678",
			archive_sha256: "a".repeat(64),
			approval_granted: false,
		};
		await operation(directory, prepared);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

function fixture(prepared, changes = {}) {
	const calls = [];
	const authDirectories = new Set();
	let tagReads = 0;
	const tag = `candidate-${prepared.identity.commit}-${prepared.identity.run_id}-${prepared.identity.run_attempt}`;
	const tagResource = `${target.resource}/packages/runtime/tags/${tag}`;
	const tagRecord = {
		name: tagResource,
		version: `${target.resource}/packages/runtime/versions/${digest}`,
		...changes.tag,
	};
	const request = async (url, init) => {
		calls.push({ kind: "api", url });
		assert.equal(init.method, "GET");
		assert.equal(init.redirect, "error");
		assert.equal(init.headers.Authorization, `Bearer ${token}`);
		if (url === `https://artifactregistry.googleapis.com/v1/${target.resource}`)
			return Response.json({
				name: target.resource,
				format: "DOCKER",
				mode: "STANDARD_REPOSITORY",
				labels: { application: "lexcerta", environment: "staging" },
				dockerConfig: { immutableTags: true },
				...changes.repository,
			});
		assert.equal(url, `https://artifactregistry.googleapis.com/v1/${tagResource}`);
		if (tagReads++ === 0 && !changes.existing) return new Response(null, { status: 404 });
		return Response.json(tagRecord);
	};
	const command = async (binary, args, options) => {
		calls.push({ kind: binary, args });
		authDirectories.add(options.env.DOCKER_CONFIG);
		const path = join(options.env.DOCKER_CONFIG, "config.json");
		assert.equal((await lstat(path)).mode & 0o777, 0o600);
		const auth = JSON.parse(await readFile(path, "utf8"));
		assert.deepEqual(Object.keys(auth.auths), ["us-central1-docker.pkg.dev"]);
		assert.equal(
			Buffer.from(auth.auths["us-central1-docker.pkg.dev"].auth, "base64").toString(),
			`oauth2accesstoken:${token}`,
		);
		assert.ok(!args.some((arg) => arg.includes(token)));
		assert.ok(options.signal instanceof AbortSignal);
		if (changes.failCommand && (changes.failCommand === args[0] || changes.failCommand === args[1]))
			throw new Error(`provider error includes ${token}`);
		if (binary === "crane") {
			if (args[0] === "version") return changes.version ?? "0.22.1\n";
			if (args[0] === "digest") return changes.digest ?? digest;
			if (args[0] === "manifest") return changes.manifest ?? manifest;
			assert.deepEqual(args, ["validate", "--remote", `${target.image}@${digest}`]);
			return "PASS";
		}
		assert.equal(binary, "docker");
		if (args[1] === "inspect")
			return JSON.stringify([
				{
					Id: prepared.image_id,
					RepoDigests: [`${target.image}@${digest}`],
					Architecture: "amd64",
					Os: "linux",
					...changes.inspected,
				},
			]);
		return "";
	};
	return { calls, authDirectories, request, command, accessToken: token };
}

test("publication binds the exact registry digest to the prepared image and deletes temporary credentials", async () =>
	withCandidate(async (directory, prepared) => {
		const client = fixture(prepared);
		const published = await publishStagingCandidate(directory, prepared, project, client);
		assert.equal(published.registry_digest, digest);
		assert.notEqual(published.registry_digest, prepared.image_id);
		assert.equal(published.image_reference, `${target.image}@${digest}`);
		assert.equal(published.stage, "staging_image_published");
		assert.equal(published.approval_granted, false);
		assert.equal(published.reused_existing_tag, false);
		assert.equal(
			client.calls.filter((call) => call.kind === "docker" && call.args[1] === "push").length,
			1,
		);
		for (const path of client.authDirectories)
			await assert.rejects(access(path), { code: "ENOENT" });
		assert.ok(!JSON.stringify(published).includes(token));
	}));

test("an existing matching immutable tag is fully verified without another push", async () =>
	withCandidate(async (directory, prepared) => {
		const client = fixture(prepared, { existing: true });
		const published = await publishStagingCandidate(directory, prepared, project, client);
		assert.equal(published.reused_existing_tag, true);
		assert.equal(
			client.calls.filter(
				(call) => call.kind === "docker" && ["tag", "push"].includes(call.args[1]),
			).length,
			0,
		);
	}));

test("foreign, production, mutable, virtual and non-Docker repositories cannot receive a push", async () =>
	withCandidate(async (directory, prepared) => {
		for (const repository of [
			{ name: "elsewhere" },
			{ labels: { application: "lexcerta", environment: "production" } },
			{ labels: {} },
			{ dockerConfig: { immutableTags: false } },
			{ mode: "VIRTUAL_REPOSITORY" },
			{ format: "NPM" },
		]) {
			const client = fixture(prepared, { repository });
			await assert.rejects(publishStagingCandidate(directory, prepared, project, client), {
				message: "Staging image publication unavailable",
			});
			assert.equal(client.calls.length, 1);
			assert.equal(client.authDirectories.size, 0);
		}
	}));

test("wrong tag scope, registry bytes, digest or pulled image identity cannot yield a published result", async () =>
	withCandidate(async (directory, prepared) => {
		for (const change of [
			{ tag: { name: "elsewhere" } },
			{ tag: { version: `projects/elsewhere/versions/${digest}` } },
			{ digest: `sha256:${"b".repeat(64)}` },
			{ manifest: Buffer.from("changed manifest") },
			{ inspected: { Id: `sha256:${"b".repeat(64)}` } },
			{ inspected: { RepoDigests: [] } },
			{ inspected: { Architecture: "arm64" } },
			{ failCommand: "validate" },
		]) {
			const client = fixture(prepared, change);
			await assert.rejects(publishStagingCandidate(directory, prepared, project, client), {
				message: "Staging image publication unavailable",
			});
			for (const path of client.authDirectories)
				await assert.rejects(access(path), { code: "ENOENT" });
		}
	}));

test("tool version and provider failures are sanitized, remove credentials and never fall back to another target", async () =>
	withCandidate(async (directory, prepared) => {
		for (const change of [
			{ version: "0.20.0" },
			{ failCommand: "push" },
			{ failCommand: "pull" },
		]) {
			const client = fixture(prepared, change);
			await assert.rejects(publishStagingCandidate(directory, prepared, project, client), {
				message: "Staging image publication unavailable",
			});
			for (const path of client.authDirectories)
				await assert.rejects(access(path), { code: "ENOENT" });
		}
	}));

test("invalid targets, credentials, cancelled calls and altered evidence make no provider requests", async () =>
	withCandidate(async (directory, prepared) => {
		for (const project of ["", "../outside", "https://example.com", "PROJECT"])
			assert.throws(() => stagingRepository(project));
		const client = fixture(prepared);
		await assert.rejects(
			publishStagingCandidate(directory, prepared, project, {
				...client,
				accessToken: "bad\nheader",
			}),
		);
		await assert.rejects(
			publishStagingCandidate(directory, prepared, project, {
				...client,
				signal: AbortSignal.abort(),
			}),
		);
		await writeFile(join(directory, "runtime.tar"), "changed bytes");
		await assert.rejects(publishStagingCandidate(directory, prepared, project, client));
		assert.equal(client.calls.length, 0);
	}));

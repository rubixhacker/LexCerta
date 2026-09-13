import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { verifyCandidate } from "./release-candidate.mjs";

const inspectFiles = `
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
function hashes(root) {
  const result = {};
  function walk(relative) {
    for (const entry of readdirSync(root + '/' + relative, {withFileTypes:true})) {
      const path = relative + entry.name;
      if (entry.isDirectory()) walk(path + '/');
      else {
        assert.ok(entry.isFile());
        result[path] = createHash('sha256').update(readFileSync(root + '/' + path)).digest('hex');
      }
    }
  }
  walk('');
  return result;
}
console.log(JSON.stringify({node:process.versions.node,architecture:process.arch,uid:process.getuid(),build_id:process.env.LEXCERTA_BUILD_ID,compiled_sha256:hashes('/app/build'),migrations_sha256:hashes('/app/database/migrations')}));
`;

async function dockerCommand(args, { signal, timeout = 30_000 } = {}) {
	return (
		await promisify(execFile)("docker", args, { signal, timeout, maxBuffer: 1_048_576 })
	).stdout.trim();
}

// A successful load binds the archive's actual loaded identity, not an image
// that happened to be present in the daemon before this command.
export async function loadCandidateImage(
	directory,
	expectedIdentity,
	{ docker = dockerCommand, signal } = {},
) {
	const abort = AbortSignal.any([AbortSignal.timeout(300_000), ...(signal ? [signal] : [])]);
	let container;
	try {
		const candidate = await verifyCandidate(directory, expectedIdentity, { signal: abort });
		const loaded = await docker(["image", "load", "--input", resolve(directory, "runtime.tar")], {
			signal: abort,
			timeout: 180_000,
		});
		assert.equal(loaded.trim(), `Loaded image ID: ${candidate.image_id}`);
		const inspected = JSON.parse(
			await docker(["image", "inspect", candidate.image_id], { signal: abort }),
		);
		assert.equal(inspected.length, 1);
		const image = inspected[0];
		assert.equal(image.Id, candidate.image_id);
		assert.equal(image.Os, "linux");
		assert.equal(image.Architecture, candidate.architecture);
		assert.equal(image.Config.User, "node");
		assert.equal(image.Config.WorkingDir, "/app");
		assert.equal(
			image.Config.Labels?.["org.opencontainers.image.revision"],
			candidate.identity.commit,
		);
		assert.ok(image.Config.Env.includes(`LEXCERTA_BUILD_ID=${candidate.identity.commit}`));
		assert.ok(!image.Config.Env.some((value) => /^(NODE_OPTIONS|NODE_PATH)=/.test(value)));
		assert.ok(Object.keys(image.Config.Volumes ?? {}).length === 0);
		container = `lexcerta-image-check-${randomUUID()}`;
		const actual = JSON.parse(
			await docker(
				[
					"run",
					"--rm",
					"--name",
					container,
					"--platform",
					"linux/amd64",
					"--network",
					"none",
					"--read-only",
					"--cap-drop",
					"ALL",
					"--security-opt",
					"no-new-privileges",
					"--pids-limit",
					"64",
					"--memory",
					"1g",
					"--cpus",
					"1",
					"--user",
					"1000:1000",
					"--entrypoint",
					"node",
					candidate.image_id,
					"--input-type=module",
					"-e",
					inspectFiles,
				],
				{ signal: abort },
			),
		);
		assert.equal(actual.node, candidate.node);
		assert.equal(actual.architecture, "x64");
		assert.equal(actual.uid, 1000);
		assert.equal(actual.build_id, candidate.identity.commit);
		assert.deepEqual(actual.compiled_sha256, candidate.compiled_sha256);
		assert.deepEqual(actual.migrations_sha256, candidate.migrations_sha256);
		abort.throwIfAborted();
		return {
			stage: "image_verified",
			identity: candidate.identity,
			image_id: candidate.image_id,
			compiled_sha256: actual.compiled_sha256,
			migrations_sha256: actual.migrations_sha256,
			approval_granted: false,
		};
	} catch {
		throw new Error("Release candidate image unavailable");
	} finally {
		if (container) await docker(["rm", "--force", container]).catch(() => undefined);
	}
}

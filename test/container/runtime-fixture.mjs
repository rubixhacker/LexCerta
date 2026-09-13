import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

export const image = process.env.LEXCERTA_TEST_IMAGE;
if (!image) throw new Error("LEXCERTA_TEST_IMAGE must name the locally built public runtime image");
const dockerArgs = [
	...(process.env.LEXCERTA_TEST_DOCKER_CONFIG
		? ["--config", process.env.LEXCERTA_TEST_DOCKER_CONFIG]
		: []),
	...(process.env.LEXCERTA_TEST_DOCKER_HOST
		? ["--host", process.env.LEXCERTA_TEST_DOCKER_HOST]
		: []),
];
export async function docker(...args) {
	const result = await promisify(execFile)("docker", [...dockerArgs, ...args], {
		timeout: 30_000,
		maxBuffer: 1_048_576,
	});
	return (args[0] === "logs" ? result.stdout + result.stderr : result.stdout).trim();
}
export async function until(condition, timeout = 15_000) {
	const deadline = performance.now() + timeout;
	while (!(await condition())) {
		assert.ok(performance.now() < deadline, "container did not reach the required stage");
		await delay(50);
	}
}

export async function verifyImage(files) {
	const inspected = JSON.parse(await docker("image", "inspect", image))[0];
	assert.equal(inspected.Architecture, "amd64");
	assert.equal(inspected.Os, "linux");
	assert.equal(inspected.Config.User, "node");

	const hashes = Object.fromEntries(
		await Promise.all(
			files.map(async (file) => [
				file,
				createHash("sha256")
					.update(await readFile(`build/${file}`))
					.digest("hex"),
			]),
		),
	);
	const actual = JSON.parse(
		await docker(
			"run",
			"--rm",
			"--platform",
			"linux/amd64",
			"--network",
			"none",
			image,
			"node",
			"--input-type=module",
			"-e",
			`
import { createHash } from 'node:crypto'; import { readFileSync } from 'node:fs';
console.log(JSON.stringify({node: process.version, arch: process.arch, uid: process.getuid(), files:
Object.fromEntries(${JSON.stringify(files)}.map(file =>
[file, createHash('sha256').update(readFileSync('build/' + file)).digest('hex')]))}));`,
		),
	);
	assert.deepEqual(actual.files, hashes, "container must contain the current compiled runtime");
	assert.equal(actual.node, "v24.21.0");
	assert.equal(actual.arch, "x64");
	assert.equal(actual.uid, 1000);
	return inspected;
}

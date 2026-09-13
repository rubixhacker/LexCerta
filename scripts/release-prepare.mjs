import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CandidateIdentity } from "./release-candidate.mjs";
import { downloadCandidateArchive } from "./release-download.mjs";
import { extractCandidateArchive } from "./release-extract.mjs";
import { RELEASE_REPOSITORY } from "./release-github.mjs";
import { loadCandidateImage } from "./release-image.mjs";

export async function prepareCandidate(expectedIdentity, directory, options = {}) {
	let created = false;
	try {
		const identity = CandidateIdentity.parse(expectedIdentity);
		options.signal?.throwIfAborted();
		await mkdir(directory, { mode: 0o700 });
		created = true;
		const archive = join(directory, "candidate.zip");
		const unpacked = join(directory, "candidate");
		const origin = await downloadCandidateArchive(identity, archive, options);
		await extractCandidateArchive(archive, unpacked, origin, options);
		const image = await loadCandidateImage(unpacked, identity, options);
		const handoff = {
			...image,
			artifact_id: origin.artifact_id,
			archive_sha256: origin.archive_sha256,
			archive_bytes: origin.archive_bytes,
		};
		await writeFile(join(directory, "handoff.json"), `${JSON.stringify(handoff, null, 2)}\n`, {
			flag: "wx",
			mode: 0o600,
			signal: options.signal,
		});
		return handoff;
	} catch {
		if (created) await rm(directory, { recursive: true, force: true });
		throw new Error("Release candidate preparation unavailable");
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		const args = process.argv.slice(2);
		assert.equal(args.length, 8);
		assert.deepEqual(
			args.filter((_arg, index) => index % 2 === 0),
			["--run-id", "--run-attempt", "--commit", "--output-directory"],
		);
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
			JSON.stringify(await prepareCandidate(identity, args[7], { token: process.env.GH_TOKEN })),
		);
	} catch {
		console.error("Release candidate preparation unavailable; no deployment is authorized");
		process.exitCode = 1;
	}
}

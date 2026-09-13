import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CandidateIdentity } from "./release-candidate.mjs";
import { RELEASE_REPOSITORY } from "./release-github.mjs";
import { prepareCandidate } from "./release-prepare.mjs";
import { inspectReleaseProtection } from "./release-readiness.mjs";
import { publishStagingCandidate, stagingRepository } from "./release-registry.mjs";

export async function publishStagingRelease(
	identity,
	projectId,
	directory,
	{
		githubToken,
		accessToken,
		githubRequest = fetch,
		registryRequest = fetch,
		docker,
		command,
		crane,
		signal,
	} = {},
) {
	CandidateIdentity.parse(identity);
	stagingRepository(projectId);
	const protection = await inspectReleaseProtection({ token: githubToken, request: githubRequest });
	assert.equal(protection.protection_ready, true);
	const prepared = await prepareCandidate(identity, directory, {
		token: githubToken,
		request: githubRequest,
		docker,
		signal,
	});
	const currentProtection = await inspectReleaseProtection({
		token: githubToken,
		request: githubRequest,
	});
	assert.equal(currentProtection.protection_ready, true);
	const published = await publishStagingCandidate(
		join(directory, "candidate"),
		prepared,
		projectId,
		{ accessToken, request: registryRequest, command, crane, signal },
	);
	await writeFile(join(directory, "published.json"), `${JSON.stringify(published, null, 2)}\n`, {
		flag: "wx",
		mode: 0o600,
		signal,
	});
	return published;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		const args = process.argv.slice(2);
		assert.equal(args.length, 10);
		assert.deepEqual(
			args.filter((_arg, index) => index % 2 === 0),
			["--run-id", "--run-attempt", "--commit", "--project-id", "--output-directory"],
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
			JSON.stringify(
				await publishStagingRelease(identity, args[7], args[9], {
					githubToken: process.env.GH_TOKEN,
					accessToken: process.env.GOOGLE_OAUTH_ACCESS_TOKEN,
					crane: process.env.LEXCERTA_CRANE,
				}),
			),
		);
	} catch {
		console.error("Staging image publication unavailable; no deployment is authorized");
		process.exitCode = 1;
	}
}

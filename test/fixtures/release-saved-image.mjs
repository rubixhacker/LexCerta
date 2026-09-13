import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Candidate, candidateFiles, hashFile } from "../../scripts/release-candidate.mjs";
import { candidateEntries, fixtureIdentity } from "./release-archive.mjs";

// Actual image bytes with explicitly synthetic verifier metadata. This is never
// a hosted release candidate or evidence of a new soak.
export async function saveImageFixture(directory, image, docker) {
	await mkdir(directory);
	const inspected = JSON.parse(await docker("image", "inspect", image))[0];
	const identity = {
		...fixtureIdentity,
		commit: inspected.Config.Labels["org.opencontainers.image.revision"],
	};
	const hashes = async (root, files) =>
		Object.fromEntries(
			await Promise.all(files.map(async (file) => [file, await hashFile(join(root, file))])),
		);
	const compiled = await hashes(
		"build",
		(await readdir("build", { recursive: true })).filter((name) => name.endsWith(".js")),
	);
	const migrations = await hashes(
		"database/migrations",
		(await readdir("database/migrations")).filter((name) => name.endsWith(".sql")),
	);
	const { entries, candidate } = await candidateEntries();
	for (const entry of entries)
		if (entry.name !== "runtime.tar" && entry.name !== "candidate.json")
			await writeFile(join(directory, entry.name), entry.bytes);
	const soak = JSON.parse(await readFile(join(directory, "soak.json"), "utf8"));
	soak.image = inspected.Id;
	soak.compiled_sha256 = compiled;
	await writeFile(join(directory, "soak.json"), JSON.stringify(soak));
	await docker("image", "save", "--output", join(directory, "runtime.tar"), inspected.Id);
	const record = Candidate.parse({
		...candidate,
		identity,
		image_id: inspected.Id,
		compiled_sha256: compiled,
		migrations_sha256: migrations,
		files: await hashes(directory, candidateFiles),
	});
	await writeFile(join(directory, "candidate.json"), JSON.stringify(record));
	return record;
}

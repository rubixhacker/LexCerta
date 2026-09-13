import assert from "node:assert/strict";
import {
	access,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { candidateEntries, fixtureOrigin, zipFixture } from "../test/fixtures/release-archive.mjs";
import { extractCandidateArchive } from "./release-extract.mjs";

async function withArchive(entries, operation, options) {
	const root = await mkdtemp(join(tmpdir(), "lexcerta-extract-"));
	const archive = zipFixture(entries, options);
	const path = join(root, "candidate.zip");
	const output = join(root, "unpacked");
	await writeFile(path, archive);
	try {
		await operation({ root, path, output, archive, origin: fixtureOrigin(archive) });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test("stored and deflated archives unpack exactly the candidate and preserve byte identity", async () => {
	const { entries, candidate } = await candidateEntries();
	for (const compressed of [false, true])
		await withArchive(
			entries,
			async ({ path, output, origin }) => {
				assert.deepEqual(await extractCandidateArchive(path, output, origin), candidate);
				assert.deepEqual((await readdir(output)).sort(), entries.map(({ name }) => name).sort());
				assert.equal((await lstat(output)).mode & 0o777, 0o700);
				for (const entry of entries) {
					assert.deepEqual(await readFile(join(output, entry.name)), entry.bytes);
					assert.equal((await lstat(join(output, entry.name))).mode & 0o777, 0o600);
				}
			},
			{ compressed },
		);
});

test("unexpected, absolute, traversing, nested, duplicate and backslash names cannot escape extraction", async () => {
	const { entries } = await candidateEntries();
	for (const name of [
		"../escaped",
		"/tmp/escaped",
		"sub/runtime.tar",
		"runtime\\.tar",
		"repository.log",
		"unexpected.txt",
		"./runtime.tar",
		"runtime.tar\0",
	]) {
		const changed = entries.map((entry, index) => (index ? entry : { ...entry, name }));
		await withArchive(changed, async ({ root, path, output, origin }) => {
			await assert.rejects(extractCandidateArchive(path, output, origin), {
				message: "Release candidate extraction unavailable",
			});
			assert.deepEqual(await readdir(root), ["candidate.zip"]);
		});
	}
});

test("symlinks, devices, directories and encrypted or unsupported entries are rejected", async () => {
	const { entries } = await candidateEntries();
	for (const change of [
		{ attributes: (0o120777 << 16) >>> 0 },
		{ attributes: (0o020600 << 16) >>> 0 },
		{ attributes: 0x10 },
		{ flags: 1 },
		{ flags: 0x40 },
		{ method: 99 },
	]) {
		await withArchive(
			entries.map((entry, index) => (index ? entry : { ...entry, ...change })),
			async ({ path, output, origin }) => {
				await assert.rejects(extractCandidateArchive(path, output, origin));
				await assert.rejects(access(output), { code: "ENOENT" });
			},
		);
	}
});

test("missing and extra entries, declared overflow, inflated size mismatch and bad CRC fail closed", async () => {
	const { entries } = await candidateEntries();
	for (const changed of [
		entries.slice(1),
		[...entries, entries[0]],
		...[{ size: 2_147_483_649 }, { size: 1 }, { crc: 0 }].map((change) =>
			entries.map((entry, index) => (index ? entry : { ...entry, ...change })),
		),
		entries.map((entry) =>
			entry.name === "candidate.json" ? { ...entry, size: 4_194_305 } : entry,
		),
	]) {
		await withArchive(changed, async ({ path, output, origin }) => {
			await assert.rejects(extractCandidateArchive(path, output, origin));
			await assert.rejects(access(output), { code: "ENOENT" });
		});
	}
});

test("a correct archive hash does not excuse altered candidate bytes or a different run identity", async () => {
	const { entries } = await candidateEntries();
	await withArchive(
		entries.map((entry) =>
			entry.name === "runtime.tar"
				? { ...entry, bytes: Buffer.from("changed image bytes") }
				: entry,
		),
		async ({ path, output, origin }) => {
			await assert.rejects(extractCandidateArchive(path, output, origin));
			await assert.rejects(access(output), { code: "ENOENT" });
		},
	);
	await withArchive(entries, async ({ path, output, origin }) => {
		await assert.rejects(
			extractCandidateArchive(path, output, {
				...origin,
				identity: { ...origin.identity, run_attempt: "3" },
			}),
		);
		await assert.rejects(access(output), { code: "ENOENT" });
	});
});

test("changed, truncated or symlinked archives and existing destinations are not consumed", async () => {
	const { entries } = await candidateEntries();
	await withArchive(entries, async ({ root, path, output, origin, archive }) => {
		for (const bytes of [Buffer.alloc(archive.length), archive.subarray(1)]) {
			await writeFile(path, bytes);
			await assert.rejects(extractCandidateArchive(path, output, origin));
			await assert.rejects(access(output), { code: "ENOENT" });
		}
		await writeFile(path, archive);
		const linked = join(root, "linked.zip");
		await symlink(path, linked);
		await assert.rejects(extractCandidateArchive(linked, output, origin));
		await mkdir(output);
		await writeFile(join(output, "keep"), "existing evidence");
		await assert.rejects(extractCandidateArchive(path, output, origin));
		assert.equal(await readFile(join(output, "keep"), "utf8"), "existing evidence");
	});
});

test("malformed ZIP metadata fails even when its actual archive hash was verified", async () => {
	const { entries } = await candidateEntries();
	await withArchive(entries, async ({ path, output, origin, archive }) => {
		const broken = Buffer.from(archive);
		broken.fill(0, broken.length - 22);
		await writeFile(path, broken);
		await assert.rejects(
			extractCandidateArchive(path, output, { ...origin, ...fixtureOrigin(broken) }),
		);
		await assert.rejects(access(output), { code: "ENOENT" });
	});
});

test("cancellation during inflation removes the partial directory and closes archive I/O", async () => {
	const { entries } = await candidateEntries({ "runtime.tar": Buffer.alloc(16_777_216, 65) });
	await withArchive(entries, async ({ path, output, origin }) => {
		const controller = new AbortController();
		const extraction = extractCandidateArchive(path, output, origin, { signal: controller.signal });
		const rejected = assert.rejects(extraction, {
			message: "Release candidate extraction unavailable",
		});
		let found = false;
		for (let attempt = 0; attempt < 1000 && !found; attempt++) {
			found = await access(join(output, "runtime.tar")).then(
				() => true,
				() => false,
			);
			if (!found) await delay(1);
		}
		assert.equal(found, true);
		controller.abort();
		await rejected;
		await assert.rejects(access(output), { code: "ENOENT" });
		assert.equal((await lstat(path)).isFile(), true);
	});
});

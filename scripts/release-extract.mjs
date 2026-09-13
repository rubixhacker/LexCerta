import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { constants, close, createReadStream, createWriteStream, fstat, open } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { crc32 } from "node:zlib";
import { fromFdPromise } from "yauzl";
import { CandidateIdentity, candidateFileLimits, verifyCandidate } from "./release-candidate.mjs";

const MAX_BYTES = 2_147_483_648;

async function verifyArchiveDescriptor(fd, origin, signal) {
	const stat = await promisify(fstat)(fd);
	assert.ok(stat.isFile());
	assert.equal(stat.size, origin.archive_bytes);
	const hash = createHash("sha256");
	for await (const bytes of createReadStream(null, { fd, autoClose: false, start: 0, signal }))
		hash.update(bytes);
	assert.equal(hash.digest("hex"), origin.archive_sha256);
}

// Origin must come from the downloader in this process. Serialized reports are
// not credentials. The prepare command always establishes origin afresh.
export async function extractCandidateArchive(archive, directory, origin, { signal } = {}) {
	const abort = AbortSignal.any([AbortSignal.timeout(180_000), ...(signal ? [signal] : [])]);
	let fd;
	let zip;
	let created = false;
	try {
		abort.throwIfAborted();
		CandidateIdentity.parse(origin.identity);
		assert.equal(origin.stage, "download_verified");
		assert.equal(origin.approval_granted, false);
		assert.match(origin.artifact_id, /^[1-9][0-9]{0,15}$/);
		assert.match(origin.archive_sha256, /^[a-f0-9]{64}$/);
		assert.ok(
			Number.isSafeInteger(origin.archive_bytes) &&
				origin.archive_bytes > 0 &&
				origin.archive_bytes <= MAX_BYTES,
		);
		fd = await promisify(open)(archive, constants.O_RDONLY | constants.O_NOFOLLOW);
		await verifyArchiveDescriptor(fd, origin, abort);
		zip = await fromFdPromise(fd, {
			autoClose: false,
			strictFileNames: true,
			validateEntrySizes: true,
		});
		// Retain an error listener through close, including after iteration fails.
		zip.on("error", () => undefined);
		assert.equal(zip.entryCount, Object.keys(candidateFileLimits).length);
		await mkdir(directory, { mode: 0o700 });
		created = true;
		const seen = new Set();
		let total = 0;
		for await (const entry of zip.eachEntry()) {
			abort.throwIfAborted();
			const name = entry.fileName;
			assert.ok(Object.hasOwn(candidateFileLimits, name) && !seen.has(name));
			assert.equal(entry.fileNameRaw.toString("utf8"), name);
			const kind = (entry.externalFileAttributes >>> 16) & 0xf000;
			assert.ok(kind === 0 || kind === 0x8000);
			assert.equal(entry.externalFileAttributes & 0x10, 0);
			assert.equal(entry.generalPurposeBitFlag & 0x41, 0);
			assert.ok(entry.compressionMethod === 0 || entry.compressionMethod === 8);
			assert.ok(
				Number.isSafeInteger(entry.uncompressedSize) &&
					entry.uncompressedSize > 0 &&
					entry.uncompressedSize <= candidateFileLimits[name],
			);
			total += entry.uncompressedSize;
			assert.ok(total <= MAX_BYTES);
			seen.add(name);
			let bytes = 0;
			let checksum = 0;
			const validate = new Transform({
				transform(chunk, _encoding, callback) {
					bytes += chunk.length;
					if (bytes > entry.uncompressedSize) return callback(new Error("Entry size mismatch"));
					checksum = crc32(chunk, checksum);
					callback(null, chunk);
				},
			});
			const stream = await zip.openReadStreamPromise(entry);
			await pipeline(
				stream,
				validate,
				createWriteStream(join(directory, name), { flags: "wx", mode: 0o600 }),
				{ signal: abort },
			);
			assert.equal(bytes, entry.uncompressedSize);
			assert.equal(checksum, entry.crc32);
		}
		assert.deepEqual([...seen].sort(), Object.keys(candidateFileLimits).sort());
		// Re-read the same descriptor, even if someone has replaced its pathname.
		await verifyArchiveDescriptor(fd, origin, abort);
		const candidate = await verifyCandidate(directory, origin.identity, { signal: abort });
		abort.throwIfAborted();
		return candidate;
	} catch {
		if (created) await rm(directory, { recursive: true, force: true });
		throw new Error("Release candidate extraction unavailable");
	} finally {
		if (zip) {
			const closed = once(zip, "close");
			zip.close();
			await closed;
		} else if (fd !== undefined) {
			await promisify(close)(fd);
		}
	}
}

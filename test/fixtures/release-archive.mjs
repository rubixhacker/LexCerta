import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { crc32, deflateRawSync } from "node:zlib";
import { Candidate, candidateFiles } from "../../scripts/release-candidate.mjs";

export const fixtureIdentity = {
	repository: "rubixhacker/LexCerta",
	repository_id: "1157346206",
	owner_id: "1776138",
	commit: "a".repeat(40),
	run_id: "12345",
	run_attempt: "2",
	workflow: "rubixhacker/LexCerta/.github/workflows/release.yml@refs/heads/main",
};
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function candidateEntries(overrides = {}) {
	// Historical evidence exercises the verifier contract. Synthetic log and tar
	// bytes below cannot qualify a real release image or a new soak.
	const soak = JSON.parse(
		await readFile("operations/qualification/node-soak-2026-09-12/full-run.json", "utf8"),
	);
	const entries = candidateFiles.map((name) => ({
		name,
		bytes: Buffer.from(
			name === "soak.json" ? JSON.stringify(soak) : `synthetic candidate bytes: ${name}`,
		),
	}));
	for (const entry of entries) if (overrides[entry.name]) entry.bytes = overrides[entry.name];
	const candidate = Candidate.parse({
		version: 1,
		stage: "fixture_qualified",
		identity: fixtureIdentity,
		image_id: soak.image,
		node: "24.21.0",
		architecture: "amd64",
		created_at: "2026-09-13T00:00:00.000Z",
		files: Object.fromEntries(entries.map(({ name, bytes }) => [name, sha256(bytes)])),
		compiled_sha256: soak.compiled_sha256,
		migrations_sha256: { "0001_authority.sql": "b".repeat(64) },
		source_sha256: { Dockerfile: "c".repeat(64) },
	});
	entries.push({ name: "candidate.json", bytes: Buffer.from(JSON.stringify(candidate)) });
	return { entries, candidate };
}

// Minimal ZIP fixture encoder deliberately permits malformed paths, metadata
// and duplicate entries. Production extraction uses the independent yauzl parser.
export function zipFixture(entries, { compressed = true } = {}) {
	const files = [];
	const central = [];
	let offset = 0;
	for (const entry of entries) {
		const name = Buffer.from(entry.name);
		const bytes = entry.bytes;
		const data = compressed ? deflateRawSync(bytes) : bytes;
		const method = entry.method ?? (compressed ? 8 : 0);
		const checksum = entry.crc ?? crc32(bytes);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(entry.flags ?? 0, 6);
		local.writeUInt16LE(method, 8);
		local.writeUInt32LE(checksum, 14);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(entry.size ?? bytes.length, 22);
		local.writeUInt16LE(name.length, 26);
		const record = Buffer.alloc(46);
		record.writeUInt32LE(0x02014b50, 0);
		record.writeUInt16LE(0x0314, 4);
		local.copy(record, 6, 4, 28);
		record.writeUInt32LE(entry.attributes ?? (0o100600 << 16) >>> 0, 38);
		record.writeUInt32LE(offset, 42);
		files.push(local, name, data);
		central.push(record, name);
		offset += local.length + name.length + data.length;
	}
	const index = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(index.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...files, index, end]);
}

export function fixtureOrigin(archive) {
	return {
		identity: fixtureIdentity,
		artifact_id: "45678",
		archive_sha256: sha256(archive),
		archive_bytes: archive.length,
		stage: "download_verified",
		approval_granted: false,
	};
}

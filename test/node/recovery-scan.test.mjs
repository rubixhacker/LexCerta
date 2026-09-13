import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { GcsRecoveryJournal } from "../../build/node/gcs-recovery-journal.js";
import { encodeRecoveryRecord } from "../../build/postgres/recovery-journal.js";
import {
	RecoveryScanUnavailable,
	scanRecoveryJournal,
} from "../../build/postgres/recovery-scan.js";
import { withObjects } from "../fixtures/gcs-wire-fixture.mjs";

function entry(index, environment = "staging") {
	const record = {
		version: 1,
		environment,
		restriction:
			index % 3 === 0
				? { kind: "revoke_key", publicId: `synthetic-${index}` }
				: index % 3 === 1
					? {
							kind: "expire_key",
							publicId: `synthetic-${index}`,
							notAfter: "2026-09-19T03:00:00.000Z",
						}
					: { kind: "remove_opinion", opinionId: index + 1 },
	};
	const { key, bytes } = encodeRecoveryRecord(record);
	return {
		record,
		bytes,
		object: {
			key,
			generation: String(9007199254740993n + BigInt(index)),
			createdAt: "2026-09-12T03:00:00.000Z",
		},
	};
}

function readerFor(entries) {
	return {
		async list() {
			return { objects: entries.map((value) => value.object), nextPageToken: null };
		},
		async read(object) {
			return entries.find((value) => value.object.key === object.key).record;
		},
	};
}

test("scan verifies 205 exact GCS generations across three pages, excluding the other environment", async () =>
	withObjects(
		async ({ connection, values, requests }) => {
			const expected = Array.from({ length: 205 }, (_, index) => entry(index));
			for (const { object, bytes } of [...expected, entry(205, "production")])
				values.set(object.key, {
					bytes,
					metadata: {
						name: object.key,
						generation: object.generation,
						timeCreated: object.createdAt,
						size: String(bytes.length),
						md5Hash: createHash("md5").update(bytes).digest("base64"),
					},
				});
			const journal = new GcsRecoveryJournal("fixture", "staging", connection);
			const result = await scanRecoveryJournal(journal, "staging");
			assert.equal(result.pages, 3);
			assert.equal(result.entries.length, 205);
			assert.match(result.inventorySha256, /^[a-f0-9]{64}$/);
			assert.deepEqual(
				result.entries,
				expected
					.map(({ object, record }) => ({ object, record }))
					.sort((a, b) => (a.object.key < b.object.key ? -1 : 1)),
			);
			const bodies = requests.filter((request) => request.query.alt === "media");
			assert.equal(bodies.length, 205);
			assert.ok(bodies.every((request) => BigInt(request.query.generation) > 2n ** 53n));
			assert.ok(requests.every((request) => request.method === "GET"));
		},
		{ paginate: true },
	));

test("inventory identity ignores enumeration order but includes generation, creation time and environment", async () => {
	const entries = [entry(0), entry(1), entry(2)];
	const first = await scanRecoveryJournal(readerFor(entries), "staging");
	const reversed = await scanRecoveryJournal(readerFor(entries.toReversed()), "staging");
	assert.deepEqual(first, reversed);
	for (const change of [
		{ generation: "9999999999999999999" },
		{ createdAt: "2026-09-12T03:00:01.000Z" },
	]) {
		const changed = entries.map((value, index) =>
			index === 0 ? { ...value, object: { ...value.object, ...change } } : value,
		);
		assert.notEqual(
			(await scanRecoveryJournal(readerFor(changed), "staging")).inventorySha256,
			first.inventorySha256,
		);
	}
	const emptyStage = await scanRecoveryJournal(readerFor([]), "staging");
	const emptyProduction = await scanRecoveryJournal(readerFor([]), "production");
	assert.equal(emptyStage.entries.length, 0);
	assert.notEqual(emptyStage.inventorySha256, emptyProduction.inventorySha256);
});

test("multi-page cursor cycles and duplicate objects across pages fail without a partial result", async () => {
	for (const mode of ["cycle", "duplicate", "replacement"]) {
		let pages = 0;
		let reads = 0;
		const reader = {
			async list() {
				pages++;
				if (mode === "cycle")
					return { objects: [], nextPageToken: pages % 2 === 1 ? "first" : "second" };
				const object = entry(0).object;
				return {
					objects: [
						mode === "replacement" && pages > 1
							? { ...object, generation: "9999999999999999" }
							: object,
					],
					nextPageToken: pages === 1 ? "next" : null,
				};
			},
			async read() {
				reads++;
				return entry(0).record;
			},
		};
		await assert.rejects(scanRecoveryJournal(reader, "staging"), RecoveryScanUnavailable);
		assert.equal(pages, mode === "cycle" ? 3 : 2);
		assert.equal(reads, mode === "cycle" ? 0 : 1);
	}
});

test("page and record limits stop work rather than truncating the inventory", async () => {
	let pages = 0;
	let reads = 0;
	const reader = {
		async list() {
			pages++;
			return { objects: [], nextPageToken: `cursor-${pages}` };
		},
		async read() {
			reads++;
			return entry(0).record;
		},
	};
	await assert.rejects(
		scanRecoveryJournal(reader, "staging", { bounds: { maxPages: 2 } }),
		RecoveryScanUnavailable,
	);
	assert.equal(pages, 2);
	assert.equal(reads, 0);
	reader.list = async () => ({ objects: [entry(0).object, entry(1).object], nextPageToken: null });
	await assert.rejects(
		scanRecoveryJournal(reader, "staging", { bounds: { maxRecords: 1 } }),
		RecoveryScanUnavailable,
	);
	assert.equal(reads, 0);
});

test("foreign, malformed and content-mismatched records cannot enter a scan", async () => {
	const valid = entry(0);
	for (const altered of [
		entry(0, "production"),
		{ ...valid, object: { ...valid.object, generation: 9007199254740992 } },
		{ ...valid, object: { ...valid.object, createdAt: "yesterday" } },
		{ ...valid, record: entry(1).record },
		{ ...valid, record: { ...valid.record, credential: "synthetic-secret" } },
	])
		await assert.rejects(scanRecoveryJournal(readerFor([altered]), "staging"), {
			message: "recovery journal scan unavailable",
		});
});

test("bounded scan failure sanitizes provider errors and never automatically retries", async () => {
	let attempts = 0;
	for (const failureAt of ["list", "read"]) {
		const reader = readerFor([entry(0)]);
		reader[failureAt] = async () => {
			attempts++;
			throw new Error("synthetic provider secret");
		};
		await assert.rejects(scanRecoveryJournal(reader, "staging"), {
			message: "recovery journal scan unavailable",
		});
	}
	assert.equal(attempts, 2);
});

test("cancellation bounds uncooperative list and read adapters and prevents later work", async () => {
	for (const blockedAt of ["list", "read"]) {
		const reader = readerFor([entry(0)]);
		let receivedSignal;
		let finish;
		let blockedCalls = 0;
		reader[blockedAt] = async (_input, signal) => {
			receivedSignal = signal;
			blockedCalls++;
			return new Promise((resolve) => {
				finish = resolve;
			});
		};
		await assert.rejects(
			scanRecoveryJournal(reader, "staging", { bounds: { timeoutMs: 25 } }),
			RecoveryScanUnavailable,
		);
		assert.equal(receivedSignal.aborted, true);
		finish(blockedAt === "read" ? entry(0).record : { objects: [], nextPageToken: null });
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(blockedCalls, 1);
	}
});

test("already cancelled scans and invalid bounds perform no object I/O", async () => {
	let calls = 0;
	const reader = {
		async list() {
			calls++;
			throw new Error("unexpected call");
		},
	};
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		scanRecoveryJournal(reader, "staging", { signal: controller.signal }),
		RecoveryScanUnavailable,
	);
	for (const bounds of [
		{ maxPages: 101 },
		{ maxRecords: 10_001 },
		{ timeoutMs: 540_001 },
		{ timeoutMs: 0 },
		{ maxPages: 1.5 },
	])
		await assert.rejects(
			scanRecoveryJournal(reader, "staging", { bounds }),
			RecoveryScanUnavailable,
		);
	assert.equal(calls, 0);
});

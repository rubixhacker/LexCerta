import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { GcsRecoveryJournal } from "../../build/node/gcs-recovery-journal.js";
import {
	decodeRecoveryRecord,
	encodeRecoveryRecord,
	RecoveryJournalUnavailable,
} from "../../build/postgres/recovery-journal.js";
import { withObjects } from "../fixtures/gcs-wire-fixture.mjs";

const restriction = { kind: "revoke_key", publicId: "synthetic-key" };
const record = { version: 1, environment: "staging", restriction };
const journal = (connection, environment = "staging") =>
	new GcsRecoveryJournal("fixture", environment, connection);

test("recovery format permits only canonical restrictions and binds every byte and environment", () => {
	for (const value of [
		restriction,
		{ kind: "expire_key", publicId: "synthetic-key", notAfter: "2026-09-19T03:00:00.000Z" },
		{ kind: "remove_opinion", opinionId: 123 },
	]) {
		const input = { ...record, restriction: value };
		const encoded = encodeRecoveryRecord(input);
		assert.deepEqual(decodeRecoveryRecord(encoded.bytes, encoded.key, "staging"), input);
		assert.throws(
			() =>
				decodeRecoveryRecord(
					Buffer.concat([encoded.bytes, Buffer.from(" ")]),
					encoded.key,
					"staging",
				),
			RecoveryJournalUnavailable,
		);
		assert.throws(
			() => decodeRecoveryRecord(encoded.bytes, encoded.key, "production"),
			RecoveryJournalUnavailable,
		);
	}
	for (const value of [
		{ ...restriction, credential: "secret" },
		{ kind: "unrevoke_key", publicId: "synthetic-key" },
		{ kind: "remove_opinion", opinionId: 1.1 },
		{ kind: "expire_key", publicId: "synthetic-key", notAfter: "2026-09-19T03:00:00Z" },
	])
		assert.throws(() => encodeRecoveryRecord({ ...record, restriction: value }));
	assert.throws(() => encodeRecoveryRecord({ ...record, actor: "unwanted" }));
});

test("immutable append verifies a precise generation; replaying the append verifies the same object after 412", async () =>
	withObjects(async ({ connection, requests, values }) => {
		const store = journal(connection);
		const first = await store.append(restriction);
		assert.equal(first.generation, "9007199254740993");
		assert.deepEqual(await store.append(restriction), first);
		assert.deepEqual(await store.read(first), record);
		assert.equal(values.size, 1);
		assert.equal(requests.filter((request) => request.method === "POST").length, 2);
		assert.ok(
			requests
				.filter((request) => request.method === "POST")
				.every((request) => request.query.ifGenerationMatch === "0"),
		);
		assert.ok(
			requests
				.filter((request) => request.query.alt === "media")
				.every((request) => request.query.generation === first.generation),
		);
		assert.equal(
			requests.some((request) => ["DELETE", "PATCH", "PUT"].includes(request.method)),
			false,
		);
		assert.equal([...values.values()][0].metadata.cacheControl, "no-store");
	}));

test("an upload with a lost acknowledgement is not retried; an explicit retry finds its persisted restriction", async () =>
	withObjects(async ({ connection, behavior, requests, values }) => {
		const store = journal(connection);
		behavior.dropUploadResponse = true;
		await assert.rejects(store.append(restriction), RecoveryJournalUnavailable);
		assert.equal(values.size, 1);
		assert.equal(requests.length, 1);
		behavior.dropUploadResponse = false;
		const object = await store.append(restriction);
		assert.deepEqual(await store.read(object), record);
		assert.equal(values.size, 1);
	}));

test("bounded pages enumerate 205 restrictions and omit another environment", async () =>
	withObjects(
		async ({ connection, values, requests }) => {
			for (let index = 0; index < 206; index++) {
				const input = {
					...record,
					environment: index === 205 ? "production" : "staging",
					restriction: { kind: "remove_opinion", opinionId: index + 1 },
				};
				const { key, bytes } = encodeRecoveryRecord(input);
				values.set(key, {
					bytes,
					metadata: {
						name: key,
						generation: String(9007199254740993n + BigInt(index)),
						timeCreated: "2026-09-12T03:00:00.000Z",
						size: String(bytes.length),
						md5Hash: createHash("md5").update(bytes).digest("base64"),
					},
				});
			}
			const store = journal(connection);
			let token;
			const found = [];
			const sizes = [];
			do {
				const page = await store.list(token);
				found.push(...page.objects);
				sizes.push(page.objects.length);
				token = page.nextPageToken ?? undefined;
			} while (token !== undefined);
			assert.deepEqual(sizes, [100, 100, 5]);
			assert.equal(new Set(found.map((value) => value.key)).size, 205);
			assert.ok(
				requests.every(
					(request) =>
						request.query.prefix === "restrictions/v1/staging/" &&
						request.query.maxResults === "100",
				),
			);
			assert.equal((await store.read(found.at(-1))).environment, "staging");
		},
		{ paginate: true },
	));

test("missing, replaced, corrupt and oversized journal objects stop reconciliation", async () =>
	withObjects(async ({ connection, values, behavior }) => {
		const store = journal(connection);
		const object = await store.append(restriction);
		const value = values.get(object.key);
		for (const change of [
			{ ...object, generation: "9007199254740994" },
			{ ...object, createdAt: "2020-01-01T00:00:00.000Z" },
			{ ...object, key: object.key.replace("staging", "production") },
		])
			await assert.rejects(store.read(change), RecoveryJournalUnavailable);
		behavior.size = "1025";
		await assert.rejects(store.read(object), RecoveryJournalUnavailable);
		behavior.size = null;
		behavior.extraBytes = true;
		await assert.rejects(store.read(object), RecoveryJournalUnavailable);
		behavior.extraBytes = false;
		behavior.corruptChecksum = true;
		await assert.rejects(store.read(object), RecoveryJournalUnavailable);
		behavior.corruptChecksum = false;
		value.bytes[0] = 32;
		// A provider-valid checksum cannot conceal a changed content-addressed record.
		value.metadata.md5Hash = createHash("md5").update(value.bytes).digest("base64");
		await assert.rejects(store.read(object), RecoveryJournalUnavailable);
		await assert.rejects(store.append(restriction), RecoveryJournalUnavailable);
		values.clear();
		await assert.rejects(store.read(object), RecoveryJournalUnavailable);
	}));

test("repeated cursors and cross-environment listings fail instead of reporting complete", async () =>
	withObjects(async ({ connection, behavior }) => {
		await journal(connection, "production").append(restriction);
		await assert.rejects(journal(connection).list(), RecoveryJournalUnavailable);
		await assert.rejects(
			journal(connection, "production").list(behavior.nextPageToken),
			RecoveryJournalUnavailable,
		);
	}));

test("HTTP errors and redirects never retry or disclose provider messages", async () =>
	withObjects(async ({ connection, behavior, requests }) => {
		for (const status of [302, 403, 429, 503]) {
			behavior.failStatus = status;
			const before = requests.length;
			await assert.rejects(journal(connection).append(restriction), {
				message: "recovery journal unavailable; mutation outcome unknown",
			});
			assert.equal(requests.length - before, 1);
		}
	}));

test("abort cancels pending auth, upload, metadata and media without a retry", async () =>
	withObjects(async ({ connection, behavior, requests }) => {
		const store = journal(connection);
		const object = await store.append(restriction);
		behavior.stall = true;
		await assert.rejects(store.read(object, AbortSignal.timeout(40)), RecoveryJournalUnavailable);
		behavior.stall = false;
		behavior.hold = "GET";
		await assert.rejects(store.read(object, AbortSignal.timeout(40)), RecoveryJournalUnavailable);
		behavior.hold = "POST";
		await assert.rejects(
			store.append({ kind: "revoke_key", publicId: "new-key" }, AbortSignal.timeout(40)),
			RecoveryJournalUnavailable,
		);
		const before = requests.length;
		const blockedAuth = journal({ ...connection, accessToken: async () => new Promise(() => {}) });
		await assert.rejects(
			blockedAuth.append(restriction, AbortSignal.timeout(40)),
			RecoveryJournalUnavailable,
		);
		assert.equal(requests.length, before);
	}));

import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { GcsSourceObjects } from "../../build/node/gcs-source-objects.js";
import {
	MAX_SOURCE_OBJECT_BYTES,
	SourceObjectIntegrityError,
} from "../../build/postgres/objects.js";

import { withObjects } from "../fixtures/gcs-wire-fixture.mjs";

test("GCS JSON API sends immutable writes, exact generation reads/deletes and bounded pagination", async () =>
	withObjects(async ({ objects, requests }) => {
		const bytes = Buffer.from("synthetic source text");
		const key = "opinions/123/example";
		const stored = await objects.put(key, bytes, { contentHash: "fixture-hash" });
		assert.equal(stored.generation, "9007199254740993");
		assert.equal(Buffer.from(stored.bytes).toString(), bytes.toString());
		await assert.rejects(objects.put(key, bytes, {}), { code: 412 });
		const page = await objects.list("prior-page");
		assert.equal(page.nextPageToken, "fixture-next-page");
		assert.equal(page.objects[0].key, key);
		assert.equal(page.objects[0].generation, stored.generation);
		await objects.remove(key, stored.generation);
		assert.equal(await objects.read(key, stored.generation), null);
		assert.equal(await objects.generation(key), null);
		const deletion = requests.find((request) => request.method === "DELETE");
		assert.equal(deletion.query.generation, stored.generation);
		assert.equal(deletion.query.ifGenerationMatch, stored.generation);
		const listing = requests.find(
			(request) => request.path.endsWith("/o") && request.method === "GET",
		);
		assert.equal(listing.query.maxResults, "100");
		assert.equal(listing.query.pageToken, "prior-page");
		assert.equal(listing.query.prefix, "opinions/");
		assert.equal(listing.query.versions, "true");
		assert.ok(
			requests.every((request) => request.authorization === "Bearer synthetic-fixture-token"),
		);
	}));

test("GCS JSON API rejects oversized metadata before requesting a body", async () =>
	withObjects(async ({ objects, behavior, requests }) => {
		const stored = await objects.put("opinions/size", Buffer.from("fixture"), {});
		requests.length = 0;
		behavior.size = String(MAX_SOURCE_OBJECT_BYTES + 1);
		await assert.rejects(objects.read("opinions/size", stored.generation));
		assert.equal(requests.length, 1);
	}));

test("GCS JSON API bounds streamed bytes even when the advertised size is small", async () =>
	withObjects(async ({ objects, behavior }) => {
		const stored = await objects.put("opinions/overflow", Buffer.from("fixture"), {});
		behavior.extraBytes = true;
		await assert.rejects(objects.read("opinions/overflow", stored.generation));
	}));

test("GCS JSON API detects a corrupt transfer checksum", async () =>
	withObjects(async ({ objects, behavior }) => {
		const stored = await objects.put("opinions/checksum", Buffer.from("fixture"), {});
		behavior.corruptChecksum = true;
		await assert.rejects(objects.read("opinions/checksum", stored.generation));
	}));

test("GCS JSON API destroys a stalled body within the five-second transfer deadline", async () =>
	withObjects(async ({ objects, behavior, activeResponses }) => {
		const stored = await objects.put("opinions/stall", Buffer.from("fixture"), {});
		behavior.stall = true;
		const started = performance.now();
		await assert.rejects(objects.read("opinions/stall", stored.generation));
		assert.ok(performance.now() - started < 6000);
		await until(() => activeResponses.size === 0);
	}));

async function until(condition) {
	const deadline = performance.now() + 2000;
	while (!condition()) {
		assert.ok(performance.now() < deadline, "HTTP cancellation did not close the fixture response");
		await delay(10);
	}
}

test("a full-size UTF8 opinion survives immutable upload and checksum verification", async () =>
	withObjects(async ({ objects }) => {
		const bytes = Buffer.from("🧪".repeat(MAX_SOURCE_OBJECT_BYTES / 4));
		const result = await objects.put("opinions/unicode", bytes, {});
		assert.deepEqual(Buffer.from(result.bytes), bytes);
	}));

test("request cancellation closes stalled metadata, upload, listing and deletion sockets", async () =>
	withObjects(async ({ objects, behavior, requests, activeResponses }) => {
		const stored = await objects.put("opinions/cancel", Buffer.from("fixture"), {});
		behavior.hold = "all";
		for (const operation of [
			(scoped) => scoped.read("opinions/cancel", stored.generation),
			(scoped) => scoped.put("opinions/new", Buffer.from("fixture"), {}),
			(scoped) => scoped.list(),
			(scoped) => scoped.remove("opinions/cancel", stored.generation),
		]) {
			const controller = new AbortController();
			const count = requests.length;
			const rejected = assert.rejects(
				operation(objects.withSignal(controller.signal)),
				SourceObjectIntegrityError,
			);
			await until(() => requests.length === count + 1);
			controller.abort("private-legal-credential-sentinel");
			await rejected;
			await until(() => activeResponses.size === 0);
			assert.equal(requests.length, count + 1);
		}
	}));

test("the default five-second deadline closes a request that never receives headers", async () =>
	withObjects(async ({ objects, behavior, activeResponses }) => {
		behavior.hold = "all";
		const started = performance.now();
		await assert.rejects(objects.generation("opinions/no-headers"), SourceObjectIntegrityError);
		assert.ok(performance.now() - started < 6000);
		await until(() => activeResponses.size === 0);
	}));

test("upload and verification share one deadline even when each HTTP phase is individually fast", async () =>
	withObjects(async ({ objects, behavior, requests, values, activeResponses }) => {
		behavior.delayMs = 1800;
		const started = performance.now();
		await assert.rejects(
			objects.put("opinions/aggregate", Buffer.from("fixture"), {}),
			SourceObjectIntegrityError,
		);
		assert.ok(performance.now() - started < 6000);
		assert.equal(requests.length, 3);
		assert.ok(
			values.has("opinions/aggregate"),
			"the upload may persist after verification times out",
		);
		await until(() => activeResponses.size === 0);
	}));

test("a credential arriving after request cancellation cannot dispatch an object request", async () => {
	const started = Promise.withResolvers();
	const token = Promise.withResolvers();
	await withObjects(
		async ({ objects, requests }) => {
			const controller = new AbortController();
			const rejected = assert.rejects(
				objects.withSignal(controller.signal).generation("opinions/auth"),
				SourceObjectIntegrityError,
			);
			await started.promise;
			controller.abort();
			await rejected;
			token.resolve("synthetic-fixture-token");
			await delay(20);
			assert.equal(requests.length, 0);
		},
		{
			accessToken: () => {
				started.resolve();
				return token.promise;
			},
		},
	);
});

test("object credentials cannot be sent to a configured third-party endpoint", () => {
	for (const endpoint of [
		"https://example.com",
		"https://storage.googleapis.com.evil.example",
		"https://user@storage.googleapis.com",
		"https://storage.googleapis.com/path",
	]) {
		assert.throws(
			() =>
				new GcsSourceObjects("fixture", { endpoint, accessToken: async () => "private-sentinel" }),
			SourceObjectIntegrityError,
		);
	}
});

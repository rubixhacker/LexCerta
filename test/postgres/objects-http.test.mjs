import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { CRC32C, Storage } from "@google-cloud/storage";
import { GcsSourceObjects, MAX_SOURCE_OBJECT_BYTES } from "../../build/postgres/objects.js";

// An HTTP protocol fixture for the real pinned GCS SDK, not a GCS or IAM emulator.
async function withObjects(run) {
	const values = new Map();
	const requests = [];
	let nextGeneration = 9007199254740993n;
	const behavior = { extraBytes: false, size: null, corruptChecksum: false, stall: false };
	const server = createServer(async (request, response) => {
		const url = new URL(request.url, "http://fixture");
		requests.push({
			method: request.method,
			path: url.pathname,
			query: Object.fromEntries(url.searchParams),
			authorization: request.headers.authorization,
		});
		function json(status, body) {
			response.writeHead(status, { "content-type": "application/json" });
			response.end(JSON.stringify(body));
		}
		const name =
			url.searchParams.get("name") ?? decodeURIComponent(url.pathname.split("/o/")[1] ?? "");
		if (request.method === "POST" && url.pathname.startsWith("/upload/")) {
			if (url.searchParams.get("ifGenerationMatch") !== "0")
				return json(400, { error: { message: "missing create precondition" } });
			if (values.has(name)) return json(412, { error: { code: 412, message: "existing object" } });
			const chunks = [];
			for await (const chunk of request) chunks.push(chunk);
			const text = Buffer.concat(chunks).toString("utf8");
			const boundary = request.headers["content-type"].match(/boundary="?([^";]+)"?/)[1];
			const parts = text.split(`--${boundary}`);
			const metadata = JSON.parse(parts[1].split("\r\n\r\n")[1].trim());
			const bytes = Buffer.from(parts[2].slice(parts[2].indexOf("\r\n\r\n") + 4, -2));
			const crc = new CRC32C();
			crc.update(bytes);
			const stored = {
				...metadata,
				name,
				generation: String(nextGeneration++),
				size: String(bytes.length),
				timeCreated: new Date().toISOString(),
				crc32c: crc.toString(),
			};
			values.set(name, { bytes, metadata: stored });
			return json(200, stored);
		}
		if (request.method === "GET" && url.pathname.endsWith("/o"))
			return json(200, {
				items: [...values.values()].map((value) => value.metadata),
				nextPageToken: "fixture-next-page",
			});
		const value = values.get(name);
		const requestedGeneration = url.searchParams.get("generation");
		if (
			!value ||
			(requestedGeneration !== null && requestedGeneration !== value.metadata.generation)
		)
			return json(404, { error: { code: 404, message: "absent" } });
		if (request.method === "DELETE") {
			if (url.searchParams.get("ifGenerationMatch") !== value.metadata.generation)
				return json(412, { error: { code: 412 } });
			values.delete(name);
			response.writeHead(204);
			return response.end();
		}
		if (url.searchParams.get("alt") === "media") {
			response.writeHead(200, {
				"content-type": "text/plain",
				"x-goog-stored-content-encoding": "identity",
				"x-goog-hash": `crc32c=${behavior.corruptChecksum ? "AAAAAA==" : value.metadata.crc32c}`,
			});
			response.flushHeaders();
			if (behavior.stall) {
				response.write(value.bytes.subarray(0, 1));
				return;
			}
			response.end(
				behavior.extraBytes ? Buffer.alloc(MAX_SOURCE_OBJECT_BYTES + 1, 65) : value.bytes,
			);
			return;
		}
		return json(200, { ...value.metadata, size: behavior.size ?? value.metadata.size });
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const storage = new Storage({
		apiEndpoint: `http://127.0.0.1:${server.address().port}`,
		projectId: "local-fixture",
		timeout: 5000,
		retryOptions: { autoRetry: false, maxRetries: 0 },
	});
	const objects = new GcsSourceObjects(storage.bucket("fixture"));
	try {
		await run({ objects, values, requests, behavior });
	} finally {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	}
}

test("GCS SDK sends immutable writes, exact generation reads/deletes and bounded pagination", async () =>
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
		assert.ok(requests.every((request) => request.authorization === undefined));
	}));

test("GCS SDK rejects oversized metadata before requesting a body", async () =>
	withObjects(async ({ objects, behavior, requests }) => {
		const stored = await objects.put("opinions/size", Buffer.from("fixture"), {});
		requests.length = 0;
		behavior.size = String(MAX_SOURCE_OBJECT_BYTES + 1);
		await assert.rejects(objects.read("opinions/size", stored.generation));
		assert.equal(requests.length, 1);
	}));

test("GCS SDK bounds streamed bytes even when the advertised size is small", async () =>
	withObjects(async ({ objects, behavior }) => {
		const stored = await objects.put("opinions/overflow", Buffer.from("fixture"), {});
		behavior.extraBytes = true;
		await assert.rejects(objects.read("opinions/overflow", stored.generation));
	}));

test("GCS SDK detects a corrupt transfer checksum", async () =>
	withObjects(async ({ objects, behavior }) => {
		const stored = await objects.put("opinions/checksum", Buffer.from("fixture"), {});
		behavior.corruptChecksum = true;
		await assert.rejects(objects.read("opinions/checksum", stored.generation));
	}));

test("GCS SDK destroys a stalled body within the five-second transfer deadline", async () =>
	withObjects(async ({ objects, behavior }) => {
		const stored = await objects.put("opinions/stall", Buffer.from("fixture"), {});
		behavior.stall = true;
		const started = performance.now();
		await assert.rejects(objects.read("opinions/stall", stored.generation));
		assert.ok(performance.now() - started < 6000);
	}));

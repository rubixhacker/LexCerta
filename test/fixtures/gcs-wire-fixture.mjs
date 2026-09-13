import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { GcsSourceObjects } from "../../build/node/gcs-source-objects.js";
import { MAX_SOURCE_OBJECT_BYTES } from "../../build/postgres/objects.js";

// A GCS JSON API wire fixture, not a GCS or IAM emulator.
export async function withObjects(run, options = {}) {
	const values = new Map();
	const requests = [];
	let nextGeneration = 9007199254740993n;
	const activeResponses = new Set();
	const behavior = {
		extraBytes: false,
		size: null,
		corruptChecksum: false,
		stall: false,
		hold: null,
		delayMs: 0,
		nextPageToken: "fixture-next-page",
		dropUploadResponse: false,
		failStatus: null,
	};
	const server = createServer(async (request, response) => {
		const url = new URL(request.url, "http://fixture");
		activeResponses.add(response);
		response.on("close", () => activeResponses.delete(response));
		requests.push({
			method: request.method,
			path: url.pathname,
			query: Object.fromEntries(url.searchParams),
			authorization: request.headers.authorization,
		});
		if (behavior.hold === "all" || behavior.hold === request.method) return;
		if (behavior.delayMs) await delay(behavior.delayMs);
		if (response.destroyed) return;
		function json(status, body) {
			response.writeHead(status, { "content-type": "application/json" });
			response.end(JSON.stringify(body));
		}
		if (behavior.failStatus !== null) return json(behavior.failStatus, { error: "synthetic" });
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
			const hash = createHash("md5").update(bytes).digest("base64");
			if (metadata.md5Hash !== hash) return json(400, { error: { code: 400 } });
			const stored = {
				...metadata,
				name,
				generation: String(nextGeneration++),
				size: String(bytes.length),
				timeCreated: new Date().toISOString(),
				md5Hash: hash,
			};
			values.set(name, { bytes, metadata: stored });
			if (behavior.dropUploadResponse) return response.destroy();
			return json(200, stored);
		}
		if (request.method === "GET" && url.pathname.endsWith("/o") && options.paginate) {
			const token = url.searchParams.get("pageToken");
			if (token !== null && !/^fixture-offset-\d+$/.test(token)) return json(400, {});
			const offset = token === null ? 0 : Number(token.slice("fixture-offset-".length));
			const items = [...values.values()]
				.map((value) => value.metadata)
				.filter((value) => value.name.startsWith(url.searchParams.get("prefix") ?? ""))
				.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
			const limit = Number(url.searchParams.get("maxResults") ?? 100);
			return json(200, {
				items: items.slice(offset, offset + limit),
				...(offset + limit < items.length
					? { nextPageToken: `fixture-offset-${offset + limit}` }
					: {}),
			});
		}
		if (request.method === "GET" && url.pathname.endsWith("/o"))
			return json(200, {
				items: [...values.values()].map((value) => value.metadata),
				...(behavior.nextPageToken === null ? {} : { nextPageToken: behavior.nextPageToken }),
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
			await options.onDelete?.(name);
			response.writeHead(204);
			return response.end();
		}
		if (url.searchParams.get("alt") === "media") {
			response.writeHead(200, {
				"content-type": "text/plain",
				"x-goog-stored-content-encoding": "identity",
				"x-goog-hash": `md5=${behavior.corruptChecksum ? "AAAAAAAAAAAAAAAAAAAAAA==" : value.metadata.md5Hash}`,
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
	const connection = {
		endpoint: `http://127.0.0.1:${server.address().port}`,
		accessToken: options.accessToken ?? (async () => "synthetic-fixture-token"),
	};
	const objects = new GcsSourceObjects("fixture", connection);
	try {
		await run({ objects, values, requests, behavior, activeResponses, connection });
	} finally {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	}
}

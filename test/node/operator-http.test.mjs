import assert from "node:assert/strict";
import { once } from "node:events";
import { connect } from "node:net";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createOperatorHttpServer } from "../../build/node/operator-http.js";

async function fixture(handle, run) {
	const runtime = createOperatorHttpServer(handle, { build: "fixture" });
	runtime.server.listen(0, "127.0.0.1");
	await once(runtime.server, "listening");
	try {
		await run(runtime, `http://127.0.0.1:${runtime.server.address().port}`);
	} finally {
		await runtime.close();
	}
}

test("operator routes and duplicate identity headers are bounded before application work", async () => {
	let calls = 0;
	await fixture(
		async () => {
			calls += 1;
			return Response.json({ ok: true });
		},
		async (_runtime, url) => {
			for (const [path, init, status] of [
				["/", { method: "POST" }, 404],
				["/v1/keys", {}, 405],
				["/v1/keys/id/limits", { method: "POST" }, 405],
				["/v1/keys?query=x", { method: "POST" }, 404],
				["/v1/sources/123/remove", {}, 405],
				["/v1/sources/01/remove", { method: "POST" }, 404],
				["/v1/sources/123/restore", { method: "POST" }, 404],
				["/v1/sources/123/remove?extra=yes", { method: "POST" }, 404],
				["/v1/keys", { method: "POST", headers: { origin: "https://attacker.invalid" } }, 403],
			])
				assert.equal((await fetch(url + path, init)).status, status);
			for (const name of [
				"X-Lexcerta-Operator-Token",
				"Authorization",
				"X-Serverless-Authorization",
			]) {
				const socket = connect({ host: "127.0.0.1", port: Number(new URL(url).port) });
				const chunks = [];
				socket.on("data", (chunk) => chunks.push(chunk));
				socket.write(
					`POST /v1/keys HTTP/1.1\r\nHost: fixture\r\n${name}: one\r\n${name}: two\r\nContent-Length: 0\r\n\r\n`,
				);
				await once(socket, "close");
				assert.match(Buffer.concat(chunks).toString(), /^HTTP\/1.1 400 /);
			}
			assert.equal(calls, 0);
			assert.equal((await fetch(`${url}/v1/keys/id`)).status, 200);
			assert.equal(calls, 1);
		},
	);
});

test("operator concurrency is two with no queue; its response cap cannot leak an oversized secret", async () => {
	const release = Promise.withResolvers();
	await fixture(
		async (request) => {
			await request.text();
			await release.promise;
			return new Response("x".repeat(16_385));
		},
		async (runtime, url) => {
			const requests = [1, 2].map(() => fetch(`${url}/v1/keys`, { method: "POST", body: "{}" }));
			try {
				const deadline = performance.now() + 1000;
				while (runtime.state.active !== 2) {
					assert.ok(performance.now() < deadline);
					await delay(10);
				}
				const excess = await fetch(`${url}/v1/keys`, { method: "POST", body: "{}" });
				assert.equal(excess.status, 503);
				assert.equal(excess.headers.get("retry-after"), "1");
			} finally {
				release.resolve();
			}
			for (const response of await Promise.all(requests)) {
				assert.equal(response.status, 503);
				assert.equal(await response.text(), "");
			}
		},
	);
});

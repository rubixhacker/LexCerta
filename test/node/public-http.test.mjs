import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createPublicHttpServer } from "../../build/node/public-http.js";

async function fixture(handle, run, options = {}) {
	const runtime = createPublicHttpServer(handle, { build: "fixture", ...options });
	runtime.server.listen(0, "127.0.0.1");
	await once(runtime.server, "listening");
	try {
		await run(runtime, `http://127.0.0.1:${runtime.server.address().port}`);
	} finally {
		await runtime.close();
	}
}

async function until(condition) {
	const deadline = performance.now() + 2000;
	while (!condition()) {
		assert.ok(performance.now() < deadline);
		await delay(10);
	}
}

test("public routes reject origins, methods and duplicate boundary headers before admission", async () => {
	let admitted = 0;
	await fixture(
		async () => {
			admitted += 1;
			return new Response("ok");
		},
		async (_runtime, url) => {
			assert.deepEqual(await (await fetch(`${url}/healthz`)).json(), {
				status: "ok",
				build: "fixture",
			});
			for (const [path, options, expected] of [
				["/admin", {}, 404],
				["/", {}, 405],
				["/", { method: "POST", headers: { origin: "https://example.com" } }, 403],
			]) {
				assert.equal((await fetch(url + path, options)).status, expected);
			}
			const socket = connect({ host: "127.0.0.1", port: Number(new URL(url).port) });
			const chunks = [];
			socket.on("data", (chunk) => chunks.push(chunk));
			socket.write(
				"POST / HTTP/1.1\r\nHost: fixture\r\nAuthorization: Bearer one\r\nAuthorization: Bearer two\r\nContent-Length: 0\r\n\r\n",
			);
			await once(socket, "close");
			assert.match(Buffer.concat(chunks).toString(), /^HTTP\/1.1 400 /);
			assert.equal(admitted, 0);
		},
	);
});

test("eight active requests fill the service envelope and the ninth is rejected without queuing", async () => {
	const release = Promise.withResolvers();
	await fixture(
		async (request) => {
			await request.text();
			await release.promise;
			return Response.json({ done: true });
		},
		async (runtime, url) => {
			const calls = Array.from({ length: 8 }, () =>
				fetch(url, { method: "POST", body: "fixture" }),
			);
			try {
				await until(() => runtime.state.active === 8);
				const excess = await fetch(url, { method: "POST", body: "fixture" });
				assert.equal(excess.status, 503);
				assert.equal(excess.headers.get("retry-after"), "1");
				assert.equal(runtime.state.active, 8);
			} finally {
				release.resolve();
			}
			for (const response of await Promise.all(calls))
				assert.deepEqual(await response.json(), { done: true });
			await until(() => runtime.state.active === 0);
		},
	);
});

test("deadline cancellation covers a stalled incoming body and frees the service slot", async () => {
	let signal;
	await fixture(
		async (request) => {
			signal = request.signal;
			await request.text();
			return new Response("late");
		},
		async (runtime, url) => {
			const status = new Promise((resolve, reject) => {
				const upload = httpRequest(
					url,
					{ method: "POST", headers: { "content-length": "100" } },
					(response) => {
						response.resume();
						resolve(response.statusCode);
					},
				);
				upload.on("error", reject);
				upload.write("x");
			});
			assert.equal(await status, 504);
			assert.equal(signal.aborted, true);
			await until(() => runtime.state.active === 0);
		},
		{ timeoutMs: 100 },
	);
});

test("a disconnected client cancels evidence work and cannot retain a concurrency slot", async () => {
	let signal;
	await fixture(
		async (request) => {
			signal = request.signal;
			await new Promise(() => {});
			return new Response("late");
		},
		async (runtime, url) => {
			const controller = new AbortController();
			const pending = assert.rejects(
				fetch(url, { method: "POST", body: "fixture", signal: controller.signal }),
			);
			await until(() => signal !== undefined);
			controller.abort();
			await pending;
			await until(() => signal.aborted && runtime.state.active === 0);
		},
	);
});

test("aggregate evidence exhaustion cancels work and reports unavailable without claiming a timeout", async () => {
	let signal;
	await fixture(
		async (_request, evidence) => {
			signal = evidence.signal;
			evidence.consumeResponseBytes(16 * 1_048_576 + 1);
			return new Response("must not publish an evidence result");
		},
		async (runtime, url) => {
			const response = await fetch(url, { method: "POST", body: "fixture" });
			assert.equal(response.status, 503);
			assert.equal(await response.text(), "");
			assert.equal(signal.aborted, true);
			await until(() => runtime.state.active === 0);
		},
	);
});

test("shutdown forcibly cancels the remaining request at its bound", async () => {
	let signal;
	await fixture(
		async (request) => {
			signal = request.signal;
			await new Promise(() => {});
			return new Response("late");
		},
		async (runtime, url) => {
			const pending = fetch(url, { method: "POST", body: "fixture" }).catch(() => undefined);
			await until(() => signal !== undefined);
			await runtime.close();
			await pending;
			assert.equal(signal.aborted, true);
			await until(() => runtime.state.active === 0);
			assert.equal(runtime.state.draining, true);
		},
		{ drainMs: 100 },
	);
});

test("shutdown lets an in-flight response finish before releasing the service", async () => {
	const entered = Promise.withResolvers();
	const release = Promise.withResolvers();
	await fixture(
		async (request) => {
			await request.text();
			entered.resolve();
			await release.promise;
			assert.equal(request.signal.aborted, false);
			return Response.json({ completed: true });
		},
		async (runtime, url) => {
			const pending = fetch(url, { method: "POST", body: "fixture" });
			await entered.promise;
			let closed = false;
			const closing = runtime.close().then(() => {
				closed = true;
			});
			await delay(30);
			assert.equal(closed, false);
			release.resolve();
			assert.deepEqual(await (await pending).json(), { completed: true });
			await closing;
			assert.equal(runtime.state.active, 0);
		},
	);
});

test("unexpected exceptions cannot expose legal content or credentials in HTTP responses", async () => {
	await fixture(
		async () => {
			throw new Error("private-legal-credential-sentinel");
		},
		async (_runtime, url) => {
			const response = await fetch(url, { method: "POST", body: "fixture" });
			assert.equal(response.status, 503);
			assert.equal(await response.text(), "");
			assert.equal(response.headers.get("cache-control"), "no-store");
		},
	);
});

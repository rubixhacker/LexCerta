import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createMetadataAccessTokenProvider } from "../../build/node/metadata-token.js";

async function fixture(run) {
	let calls = 0;
	const active = new Set();
	const behavior = { hold: null, flavor: "Google", expires: 3600, status: 200 };
	const server = createServer((request, response) => {
		calls += 1;
		assert.equal(request.headers["metadata-flavor"], "Google");
		active.add(response);
		response.on("close", () => active.delete(response));
		if (behavior.hold === "headers") return;
		response.writeHead(behavior.status, {
			"metadata-flavor": behavior.flavor,
			"content-type": "application/json",
		});
		if (behavior.hold === "body") {
			response.write('{"access_token":');
			return;
		}
		response.end(
			JSON.stringify({
				access_token: "synthetic-metadata-token",
				token_type: "Bearer",
				expires_in: behavior.expires,
			}),
		);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const token = createMetadataAccessTokenProvider((url, options) => {
		assert.equal(
			url,
			"http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
		);
		assert.equal(options.redirect, "manual");
		return fetch(`http://127.0.0.1:${server.address().port}/`, options);
	});
	try {
		await run({ token, behavior, active, calls: () => calls });
	} finally {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	}
}

test("attached service identity is fetched on demand and cached inside its expiry margin", async () =>
	fixture(async ({ token, calls, behavior }) => {
		assert.equal(calls(), 0);
		assert.equal(await token(new AbortController().signal), "synthetic-metadata-token");
		behavior.status = 500;
		assert.equal(await token(new AbortController().signal), "synthetic-metadata-token");
		assert.equal(calls(), 1);
		await assert.rejects(token(AbortSignal.abort("private-sentinel")), {
			message: "Service identity unavailable",
		});
		assert.equal(calls(), 1);
	}));

test("tokens inside the expiry margin are refreshed instead of being cached as current", async () =>
	fixture(async ({ token, behavior, calls }) => {
		behavior.expires = 60;
		await token(new AbortController().signal);
		await token(new AbortController().signal);
		assert.equal(calls(), 2);
	}));

test("metadata flavor and token lifetime failures are sanitized", async () =>
	fixture(async ({ token, behavior }) => {
		behavior.flavor = "private-sentinel";
		await assert.rejects(token(new AbortController().signal), {
			message: "Service identity unavailable",
		});
		behavior.flavor = "Google";
		behavior.expires = -1;
		await assert.rejects(token(new AbortController().signal), {
			message: "Service identity unavailable",
		});
	}));

for (const hold of ["headers", "body"]) {
	test(`metadata ${hold} stalls close the actual socket within one second`, async () =>
		fixture(async ({ token, behavior, active }) => {
			behavior.hold = hold;
			const start = performance.now();
			await assert.rejects(token(new AbortController().signal), {
				message: "Service identity unavailable",
			});
			assert.ok(performance.now() - start < 2000);
			const deadline = performance.now() + 1000;
			while (active.size) {
				assert.ok(performance.now() < deadline);
				await delay(10);
			}
		}));
}

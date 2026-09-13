import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
	createOperatorIdentityVerifier,
	OperatorIdentityUnavailable,
} from "../../build/node/operator-identity.js";
import { readOperatorConfig } from "../../build/node/runtime-config.js";
import {
	operatorAudience,
	operatorSubject,
	signedOperatorIdentity,
} from "../fixtures/operator-identity.mjs";

const identity = signedOperatorIdentity();
async function fixture(run) {
	let calls = 0;
	const active = new Set();
	const behavior = { hold: null, status: 200, body: null, age: "0" };
	const server = createServer((_request, response) => {
		calls += 1;
		active.add(response);
		response.on("close", () => active.delete(response));
		if (behavior.hold === "headers") return;
		response.writeHead(behavior.status, {
			"content-type": "application/json",
			"cache-control": "public, max-age=3600",
			age: behavior.age,
		});
		if (behavior.hold === "body") {
			response.write("{");
			return;
		}
		response.end(behavior.body ?? JSON.stringify(identity.certificates));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const verify = createOperatorIdentityVerifier(
		operatorAudience,
		[operatorSubject],
		(url, options) => {
			assert.equal(url, "https://www.googleapis.com/oauth2/v1/certs");
			assert.equal(options.redirect, "manual");
			assert.equal(new Headers(options.headers).has("authorization"), false);
			return fetch(`http://127.0.0.1:${server.address().port}`, options);
		},
	);
	try {
		await run({ verify, behavior, active, calls: () => calls });
	} finally {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	}
}

test("two cold concurrent operator requests share one bounded certificate retrieval", async () =>
	fixture(async ({ verify, calls }) => {
		assert.deepEqual(
			await Promise.all([
				verify(identity.token(), new AbortController().signal),
				verify(identity.token(), new AbortController().signal),
			]),
			[operatorSubject, operatorSubject],
		);
		assert.equal(calls(), 1);
	}));

test("Google signature, audience and immutable subject are checked; public keys are cached", async () =>
	fixture(async ({ verify, calls }) => {
		assert.equal(
			await verify(
				identity.token({ email: "untrusted-email@example.invalid" }),
				new AbortController().signal,
			),
			operatorSubject,
		);
		assert.equal(await verify(identity.token(), new AbortController().signal), operatorSubject);
		assert.equal(calls(), 1);
		const forged = signedOperatorIdentity();
		assert.equal(await verify(forged.token(), new AbortController().signal), null);
		assert.equal(
			await verify(identity.token({}, { kid: "unknown" }), new AbortController().signal),
			null,
		);
		assert.equal(calls(), 1, "unknown kids must not amplify certificate requests");
	}));

test("wrong identity, issuer, audience, algorithm and strictly expired tokens fail before fetching", async () =>
	fixture(async ({ verify, calls }) => {
		const now = Math.floor(Date.now() / 1000);
		for (const claims of [
			{ aud: "https://other.run.app" },
			{ aud: [operatorAudience] },
			{ iss: "https://attacker.invalid" },
			{ sub: "other", email: operatorSubject },
			{ exp: now },
			{ exp: now - 1 },
			{ iat: now + 31 },
			{ exp: now + 3601 },
			{ iat: String(now) },
			{ sub: "line\nbreak" },
		])
			assert.equal(await verify(identity.token(claims), new AbortController().signal), null);
		for (const header of [
			{ alg: "none" },
			{ alg: "HS256" },
			{ crit: ["unsupported"] },
			{ jku: "https://attacker.invalid" },
		])
			assert.equal(await verify(identity.token({}, header), new AbortController().signal), null);
		for (const token of [null, "x".repeat(4097), "Bearer private-token", "not.valid.json"])
			assert.equal(await verify(token, new AbortController().signal), null);
		assert.equal(calls(), 0);
	}));

test("certificate failures, excess bodies and expired caches fail closed without error contents", async () => {
	for (const behaviorOverride of [
		{ status: 302 },
		{ status: 500 },
		{ body: "private-sentinel" },
		{ body: "x".repeat(65_537) },
		{ body: "{}" },
		{ age: "3600" },
	])
		await fixture(async ({ verify, behavior, calls }) => {
			Object.assign(behavior, behaviorOverride);
			for (let i = 0; i < 2; i++)
				await assert.rejects(verify(identity.token(), new AbortController().signal), {
					message: "Operator identity verification unavailable",
				});
			assert.equal(calls(), 1, "failed certificate requests have no immediate retry");
		});
});

for (const hold of ["headers", "body"])
	test(`certificate ${hold} stalls abort the actual socket within two seconds`, async () =>
		fixture(async ({ verify, behavior, active }) => {
			behavior.hold = hold;
			const started = performance.now();
			await assert.rejects(
				verify(identity.token(), new AbortController().signal),
				OperatorIdentityUnavailable,
			);
			assert.ok(performance.now() - started < 3000);
			const deadline = performance.now() + 1000;
			while (active.size) {
				assert.ok(performance.now() < deadline);
				await delay(10);
			}
		}));

test("already cancelled authentication does not contact Google", async () =>
	fixture(async ({ verify, calls }) => {
		await assert.rejects(
			verify(identity.token(), AbortSignal.abort("private-sentinel")),
			OperatorIdentityUnavailable,
		);
		assert.equal(calls(), 0);
	}));

test("operator configuration has its own identity and at most three enrolled customer IDs", () => {
	const environment = {
		LEXCERTA_ENVIRONMENT: "staging",
		GOOGLE_CLOUD_PROJECT: "fixture-project",
		LEXCERTA_DATABASE_HOST: "ep-fixture-123.us-east-2.aws.neon.tech",
		LEXCERTA_DATABASE_PASSWORD: "synthetic-neon-fixture-password-32",
		LEXCERTA_BUILD_ID: "0".repeat(40),
		API_KEY_PEPPER: "synthetic-fixture-pepper-value-32bytes",
		LEXCERTA_OPERATOR_AUDIENCE: operatorAudience,
		LEXCERTA_OPERATOR_SUBJECTS: operatorSubject,
		LEXCERTA_PILOT_CUSTOMERS: "one,two,three",
	};
	assert.equal(readOperatorConfig(environment).keyEnvironment, "test");
	assert.equal(
		readOperatorConfig({ ...environment, LEXCERTA_ENVIRONMENT: "production" }).keyEnvironment,
		"production",
	);
	for (const override of [
		{ LEXCERTA_OPERATOR_AUDIENCE: `${operatorAudience}/` },
		{ LEXCERTA_OPERATOR_AUDIENCE: "http://localhost" },
		{ LEXCERTA_OPERATOR_SUBJECTS: "" },
		{ LEXCERTA_PILOT_CUSTOMERS: "one,two,three,four" },
		{ LEXCERTA_PILOT_CUSTOMERS: "one, " },
	])
		assert.throws(() => readOperatorConfig({ ...environment, ...override }), {
			message: "Operator service configuration is missing or invalid",
		});
});

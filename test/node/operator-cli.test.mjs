import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gcloudOperatorToken, runOperatorCommand } from "../../build/node/operator-cli.js";
import { operatorAudience } from "../fixtures/operator-identity.mjs";

const invoker = "lexcerta-operator@fixture-project.iam.gserviceaccount.com";
const environment = { LEXCERTA_OPERATOR_URL: operatorAudience, LEXCERTA_OPERATOR_INVOKER: invoker };

test("gcloud runs without a shell or token argument and bounded failures discard provider output", async () => {
	const directory = await mkdtemp(join(tmpdir(), "lexcerta-gcloud-fixture-"));
	const original = process.env.PATH;
	const originalMode = process.env.LEXCERTA_GCLOUD_FIXTURE_MODE;
	try {
		const executable = join(directory, "gcloud");
		await writeFile(
			executable,
			`#!/usr/bin/env node
import assert from 'node:assert/strict';
assert.deepEqual(process.argv.slice(2), ${JSON.stringify(["auth", "print-identity-token", `--impersonate-service-account=${invoker}`, `--audiences=${operatorAudience}`, "--quiet"])});
const mode = process.env.LEXCERTA_GCLOUD_FIXTURE_MODE;
if (mode === 'failure') { process.stderr.write('private-provider-sentinel'); process.exitCode = 1; }
else if (mode === 'overflow') process.stdout.write('x'.repeat(8192));
else if (mode === 'hold') setTimeout(() => {}, 60000);
else process.stdout.write('fixture.header.signature\\n');
`,
		);
		await chmod(executable, 0o755);
		process.env.PATH = `${directory}:${original}`;
		assert.equal(
			await gcloudOperatorToken(operatorAudience, invoker, new AbortController().signal),
			"fixture.header.signature",
		);
		for (const mode of ["failure", "overflow", "hold"]) {
			process.env.LEXCERTA_GCLOUD_FIXTURE_MODE = mode;
			await assert.rejects(
				gcloudOperatorToken(
					operatorAudience,
					invoker,
					mode === "hold" ? AbortSignal.timeout(100) : new AbortController().signal,
				),
				{ message: "Operator credential unavailable" },
			);
		}
	} finally {
		process.env.PATH = original;
		if (originalMode === undefined) {
			// biome-ignore lint/performance/noDelete: assigning undefined to process.env stores the string "undefined".
			delete process.env.LEXCERTA_GCLOUD_FIXTURE_MODE;
		} else process.env.LEXCERTA_GCLOUD_FIXTURE_MODE = originalMode;
		await rm(directory, { recursive: true });
	}
});

async function run(args, dependencies, overrides = {}) {
	let stdout = "";
	let stderr = "";
	const code = await runOperatorCommand(
		args,
		{ ...environment, ...overrides },
		{
			result: (value) => {
				stdout += value;
			},
			diagnostic: (value) => {
				stderr += value;
			},
		},
		dependencies,
	);
	return { code, stdout, stderr };
}

test("CLI status accepts only the authenticated application's exact absence response", async () => {
	for (const body of [
		{ error: "not_found" },
		{ error: "proxy_failure" },
		{ error: "not_found", extra: "private-sentinel" },
	]) {
		const result = await run(["status", "fixture-key"], {
			token: async () => "synthetic-token",
			transport: async () => Response.json(body, { status: 404 }),
		});
		if (body.error === "not_found" && !body.extra) {
			assert.equal(result.code, 0);
			assert.deepEqual(JSON.parse(result.stdout), { publicId: "fixture-key", status: "absent" });
		} else {
			assert.equal(result.code, 1);
			assert.equal(result.stdout, "");
		}
		assert.equal(result.stderr.includes("private-sentinel"), false);
	}
});

test("source-removal CLI validates opinion IDs and verifies a bounded source result", async () => {
	let calls = 0;
	const expected = {
		opinionId: 123,
		status: "removed",
		removedAt: "2026-09-12T03:00:00.000Z",
		pendingDeletionObjects: 1,
	};
	const dependencies = {
		token: async () => "synthetic-token",
		transport: async (url, init) => {
			calls++;
			assert.equal(new URL(url).pathname, "/v1/sources/123/remove");
			assert.equal(init.method, "POST");
			assert.equal(init.body, "{}");
			return Response.json(expected);
		},
	};
	const result = await run(["remove-source", "123"], dependencies);
	assert.equal(result.code, 0);
	assert.deepEqual(JSON.parse(result.stdout), expected);
	assert.match(result.stderr, /opinion ID: 123/);
	for (const target of ["0", "-1", "01", "1.5", "1e3", "9007199254740992", "123/restore"])
		assert.equal((await run(["remove-source", target], dependencies)).code, 2);
	assert.equal(calls, 1);
});

test("source-removal CLI never mistakes failed, foreign or leaking output for confirmation", async () => {
	for (const body of [
		{
			opinionId: 124,
			status: "removed",
			removedAt: "2026-09-12T03:00:00.000Z",
			pendingDeletionObjects: 0,
		},
		{
			opinionId: 123,
			status: "restored",
			removedAt: "2026-09-12T03:00:00.000Z",
			pendingDeletionObjects: 0,
		},
		{
			opinionId: 123,
			status: "removed",
			removedAt: "2026-09-12T03:00:00.000Z",
			pendingDeletionObjects: -1,
		},
		{
			opinionId: 123,
			status: "removed",
			removedAt: "2026-09-12T03:00:00.000Z",
			pendingDeletionObjects: 0,
			text: "private-source-sentinel",
		},
	]) {
		let calls = 0;
		const result = await run(["remove-source", "123"], {
			token: async () => "synthetic-token",
			transport: async () => {
				calls++;
				return Response.json(body);
			},
		});
		assert.equal(result.code, 1);
		assert.equal(result.stdout, "");
		assert.equal(calls, 1);
		assert.match(result.stderr, /Repeat remove-source 123/);
		assert.equal(result.stderr.includes("private-source-sentinel"), false);
	}
});

test("CLI rejects invalid configuration and command input before identity or network work", async () => {
	const dependencies = {
		token: () => {
			assert.fail("unexpected token request");
		},
		transport: () => {
			assert.fail("unexpected mutation");
		},
	};
	for (const args of [
		[],
		["issue", "customer", "601", "1"],
		["limits", "id", "1", "10001"],
		["revoke", "../bad"],
		["issue", "customer", "--token=secret"],
		["rotate", "id", "extra"],
	])
		assert.equal((await run(args, dependencies)).code, 2);
	for (const url of [
		"https://attacker.invalid",
		`${operatorAudience}/path`,
		"http://localhost",
		`https://secret@${new URL(operatorAudience).host}`,
	])
		assert.equal(
			(await run(["issue", "customer"], dependencies, { LEXCERTA_OPERATOR_URL: url })).code,
			2,
		);
});

test("CLI never follows redirects or retries mutations and never copies response error material", async () => {
	for (const status of [302, 401, 409, 503]) {
		let calls = 0;
		const result = await run(["issue", "customer"], {
			token: async () => "private-token-sentinel",
			transport: async (_url, options) => {
				calls += 1;
				assert.equal(options.redirect, "manual");
				return new Response("private-server-sentinel", {
					status,
					headers: { location: "https://attacker.invalid" },
				});
			},
		});
		assert.equal(calls, 1);
		assert.equal(result.code, 1);
		assert.equal(result.stdout, "");
		assert.match(result.stderr, /may have committed/);
		assert.equal(result.stderr.includes("private-"), false);
	}
});

test("CLI refuses malformed, oversized and mismatched credential responses before printing a secret", async () => {
	for (const mode of ["malformed", "oversized", "mismatched", "extra"]) {
		const result = await run(["issue", "customer"], {
			token: async () => "synthetic-identity",
			transport: async (_url, options) => {
				const publicId = JSON.parse(options.body).publicId;
				if (mode === "malformed") return new Response("private-sentinel", { status: 201 });
				if (mode === "oversized") return new Response("x".repeat(16_385), { status: 201 });
				return Response.json(
					{
						publicId: mode === "mismatched" ? "wrong" : publicId,
						credential: `lc_test_${publicId}_${"A".repeat(43)}`,
						expiresAt: new Date().toISOString(),
						...(mode === "extra" ? { debug: "private-sentinel" } : {}),
					},
					{ status: 201 },
				);
			},
		});
		assert.equal(result.code, 1);
		assert.equal(result.stdout, "");
		assert.equal(result.stderr.includes("private-sentinel"), false);
		assert.equal(result.stderr.includes("lc_test_"), false);
	}
});

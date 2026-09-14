import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { runPreflight } from "./connection-preflight.mjs";

async function fixture(t, handler) {
	const server = createServer(handler);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(
		() =>
			new Promise((resolve) => {
				server.closeAllConnections();
				server.close(resolve);
			}),
	);
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	return `http://127.0.0.1:${address.port}/mcp`;
}

const parsed = {
	jsonrpc: "2.0",
	id: 2,
	result: {
		isError: false,
		content: [],
		structuredContent: {
			outcome: "parsed",
			contractVersion: "1",
			citation: {
				volume: 347,
				reporter: "U.S.",
				page: 483,
				normalized: "347 U.S. 483",
				suffix: "",
			},
		},
	},
};

function json(res, status, body) {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}

test("reports the discovery gap when an endpoint supports bearer parsing only", async (t) => {
	// Given a reachable authenticated MCP boundary with no OAuth discovery.
	const requests = [];
	const endpoint = await fixture(t, (req, res) => {
		requests.push(req.headers.authorization);
		if (!req.headers.authorization) return json(res, 401, {});
		json(res, 200, parsed);
	});
	// When an operator runs the connection preflight.
	const report = await runPreflight({ endpoint, token: "fixture-secret", timeoutMs: 1000 });
	// Then parsing is distinguished from authentication discovery and host qualification.
	assert.equal(report.checks.unauthenticated.status, "passed");
	assert.equal(report.checks.oauthMetadata.status, "not_advertised");
	assert.equal(report.checks.statelessParsing.status, "passed");
	assert.equal(report.hostQualification, "not_tested");
	assert.equal(report.passed, false);
	assert.deepEqual(requests, [undefined, "Bearer fixture-secret"]);
	assert.ok(!JSON.stringify(report).includes("fixture-secret"));
});

test("passes discovery when metadata identifies the exact protected resource", async (t) => {
	// Given valid discovery metadata and a working parsing tool.
	const endpoint = await fixture(t, (req, res) => {
		if (req.method === "GET") {
			assert.equal(req.headers.authorization, undefined);
			return json(res, 200, {
				resource: endpoint,
				authorization_servers: ["https://issuer.example"],
			});
		}
		if (!req.headers.authorization) {
			res.setHeader("www-authenticate", `Bearer resource_metadata="${endpoint}/metadata"`);
			return json(res, 401, {});
		}
		json(res, 200, parsed);
	});
	// When discovery and parsing run over HTTP.
	const report = await runPreflight({ endpoint, token: "secret" });
	// Then only the bounded preflight passes, not OAuth login or AI-host qualification.
	assert.equal(report.passed, true);
	assert.equal(report.oauthAuthorizationFlow, "not_tested");
});

for (const [name, body] of [
	["wrong request id", { ...parsed, id: 99 }],
	["malformed content", { ...parsed, result: { ...parsed.result, content: [null] } }],
	["tool error", { ...parsed, result: { ...parsed.result, isError: true } }],
	["both result and error", { ...parsed, error: { code: -32603, message: "secret" } }],
	[
		"wrong parsed citation",
		{ ...parsed, result: { ...parsed.result, structuredContent: { outcome: "parsed" } } },
	],
]) {
	test(`rejects ${name} instead of accepting HTTP 200 as success`, async (t) => {
		// Given an invalid MCP success response.
		const endpoint = await fixture(t, (req, res) =>
			json(res, req.headers.authorization ? 200 : 401, body),
		);
		// When the fixed synthetic parsing probe executes.
		const report = await runPreflight({ endpoint, token: "secret" });
		// Then it cannot produce a positive parsing finding.
		assert.equal(report.checks.statelessParsing.status, "invalid_tool_result");
	});
}

for (const [name, respond, status] of [
	[
		"oversized JSON",
		(res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(`"${"x".repeat(65536)}"`);
		},
		"response_too_large",
	],
	[
		"malformed JSON",
		(res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end("private-invalid-json");
		},
		"invalid_json",
	],
	[
		"HTML response",
		(res) => {
			res.writeHead(200, { "content-type": "text/html" });
			res.end("private-html");
		},
		"invalid_json",
	],
	[
		"stalled body",
		(res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.write("{");
		},
		"timeout",
	],
]) {
	test(`bounds ${name} without recording its contents`, async (t) => {
		// Given an endpoint sending an unsafe or incomplete response.
		const endpoint = await fixture(t, (req, res) =>
			req.headers.authorization ? respond(res) : json(res, 401, {}),
		);
		// When the bounded request reaches it.
		const report = await runPreflight({ endpoint, token: "secret", timeoutMs: 100 });
		// Then the report includes only allowlisted failure facts.
		assert.equal(report.checks.statelessParsing.status, status);
		assert.ok(!JSON.stringify(report).includes("private-"));
	});
}

test("does not forward credentials or follow an endpoint redirect", async (t) => {
	// Given an endpoint redirecting to a second local server.
	let redirected = 0;
	const other = await fixture(t, (_req, res) => {
		redirected++;
		json(res, 200, parsed);
	});
	const endpoint = await fixture(t, (_req, res) => {
		res.writeHead(302, { location: other });
		res.end();
	});
	// When both probes receive redirects.
	const report = await runPreflight({ endpoint, token: "secret" });
	// Then neither is followed.
	assert.equal(redirected, 0);
	assert.equal(report.checks.statelessParsing.httpStatus, 302);
	assert.equal(report.passed, false);
});

test("leaves cross-origin resource metadata explicitly untested", async (t) => {
	// Given an advertised resource metadata document on another origin.
	let metadataRequests = 0;
	const other = await fixture(t, (_req, res) => {
		metadataRequests++;
		json(res, 200, {});
	});
	const endpoint = await fixture(t, (req, res) => {
		res.setHeader("www-authenticate", `Bearer resource_metadata="${other}"`);
		json(res, req.headers.authorization ? 200 : 401, parsed);
	});
	// When inspecting its challenge.
	const report = await runPreflight({ endpoint, token: "secret" });
	// Then the probe makes no request to the untrusted advertised origin.
	assert.equal(report.checks.oauthMetadata.status, "cross_origin_not_tested");
	assert.equal(metadataRequests, 0);
});

test("rejects unsafe invocation without echoing credential-bearing input", async () => {
	// Given URL credentials that must never appear in diagnostics.
	const { promisify } = await import("node:util");
	const { execFile } = await import("node:child_process");
	const run = promisify(execFile);
	// When the operator invokes the CLI.
	await assert.rejects(
		run(process.execPath, ["scripts/connection-preflight.mjs"], {
			env: {
				...process.env,
				LEXCERTA_PREFLIGHT_ENDPOINT: "https://private-secret@example.test/mcp",
				LEXCERTA_PREFLIGHT_TOKEN: "private-token",
			},
		}),
		(error) => {
			// Then invocation fails with sanitized diagnostics.
			assert.equal(error.code, 2);
			assert.equal(error.stdout, "");
			assert.ok(!error.stderr.includes("private-"));
			return true;
		},
	);
});

test("CLI reaches the real MCP handler and records only bounded machine evidence", async (t) => {
	// Given LexCerta's actual MCP handler behind a loopback fixture admission gate.
	const { spawn, execFile } = await import("node:child_process");
	const { promisify } = await import("node:util");
	const { once } = await import("node:events");
	const runtime = spawn(
		process.execPath,
		["--import", "tsx", "scripts/connection-preflight-runtime-fixture.mjs"],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	t.after(async () => {
		if (runtime.exitCode === null) {
			const closed = once(runtime, "close");
			runtime.kill();
			await closed;
		}
	});
	const endpoint = await new Promise((resolve, reject) => {
		runtime.once("error", reject);
		runtime.once("exit", () => reject(new Error("Runtime fixture exited before readiness")));
		runtime.stdout.once("data", (chunk) => resolve(chunk.toString().trim()));
	});
	// When the actual CLI calls the runtime over HTTP.
	try {
		await promisify(execFile)(process.execPath, ["scripts/connection-preflight.mjs"], {
			env: {
				...process.env,
				LEXCERTA_PREFLIGHT_ENDPOINT: endpoint,
				LEXCERTA_PREFLIGHT_TOKEN: "fixture-preflight-token",
			},
			timeout: 15000,
		});
		assert.fail("Bearer-only fixture must leave discovery unmet");
	} catch (error) {
		// Then it verifies parsing without representing fixture admission as OAuth or host proof.
		assert.equal(error.code, 1);
		const report = JSON.parse(error.stdout);
		assert.equal(report.checks.statelessParsing.status, "passed");
		assert.equal(report.checks.oauthMetadata.status, "not_advertised");
		assert.equal(report.hostQualification, "not_tested");
		assert.equal(error.stderr, "");
	}
});

test("does not interpret another scheme's realm as a Bearer challenge", async (t) => {
	// Given misleading challenge text and otherwise valid metadata.
	let metadataRequests = 0;
	const endpoint = await fixture(t, (req, res) => {
		if (req.method === "GET") {
			metadataRequests++;
			return json(res, 200, {
				resource: endpoint,
				authorization_servers: ["https://issuer.example"],
			});
		}
		res.setHeader(
			"www-authenticate",
			`Basic realm="Bearer resource_metadata="${endpoint}/metadata""`,
		);
		json(res, req.headers.authorization ? 200 : 401, parsed);
	});
	// When the challenge is inspected.
	const report = await runPreflight({ endpoint, token: "secret" });
	// Then quoted scheme text produces no positive discovery finding or fetch.
	assert.equal(report.checks.oauthMetadata.status, "not_advertised");
	assert.equal(metadataRequests, 0);
});

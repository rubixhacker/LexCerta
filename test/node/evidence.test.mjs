import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { createCourtListenerApi } from "../../build/courtlistener/api.js";
import { createCourtListenerCaseLawApi } from "../../build/courtlistener/case-law-api.js";
import { readCachedCaseLawOpinion } from "../../build/courtlistener/case-law-opinion-source.js";
import { boundedJsonBody } from "../../build/courtlistener/response-body.js";
import { NodeOpinionNormalizer } from "../../build/node/opinion-normalizer.js";
import { createCachedCitationGateway } from "../../build/verification/cached-citation-gateway.js";
import { EvidenceRequest, MAX_SOURCE_BYTES } from "../../build/verification/evidence-request.js";
import { verifyCitation } from "../../build/verification/verify-citation.js";
import { verifyQuote } from "../../build/verification/verify-quote.js";

const opinionUrl = "https://www.courtlistener.com/api/rest/v4/opinions/456/";
const cluster = {
	id: 123,
	canonicalUrl: "https://www.courtlistener.com/opinion/123/example/",
	opinionUrls: [opinionUrl],
};
const signal = () => new AbortController().signal;
const opinion = (text) => ({ id: 456, cluster_id: 123, plain_text: text });
const caseApi = (response, options = {}) =>
	createCourtListenerCaseLawApi({
		token: "fixture-only",
		transport: async () => response,
		...options,
	});
function stream(bytes, headers = {}) {
	let cancelled = false;
	return {
		response: new Response(
			new ReadableStream({
				start(controller) {
					controller.enqueue(bytes);
				},
				cancel() {
					cancelled = true;
					return new Promise(() => {});
				},
			}),
			{ headers },
		),
		cancelled: () => cancelled,
	};
}

test("a blocked event loop cannot let an overdue adapter result bypass the deadline", async () => {
	const request = new EvidenceRequest({ timeoutMs: 10 });
	try {
		await assert.rejects(
			request.run(async () => {
				const until = performance.now() + 25;
				while (performance.now() < until) {
					/* Deliberately block this fixture's event loop. */
				}
				return "overdue";
			}),
			{ reason: "timeout" },
		);
	} finally {
		request.close();
	}
});

test("a legal source above the old 64 KiB cap is accepted and UTF-8 source limits count bytes", async () => {
	assert.equal(
		(await caseApi(Response.json(opinion("x".repeat(70_000)))).getOpinion(opinionUrl)).kind,
		"found",
	);
	assert.equal(
		(await caseApi(Response.json(opinion("éé")), { maxSourceBytes: 4 }).getOpinion(opinionUrl))
			.kind,
		"found",
	);
	assert.equal(
		(await caseApi(Response.json(opinion("ééé")), { maxSourceBytes: 4 }).getOpinion(opinionUrl))
			.kind,
		"malformed_response",
	);
});

test("the selected JSON response accepts exactly 1 MiB and rejects an extra byte despite a false length", async () => {
	const overhead = Buffer.byteLength(JSON.stringify(opinion("")));
	const exact = JSON.stringify(opinion("x".repeat(MAX_SOURCE_BYTES - overhead)));
	assert.equal(Buffer.byteLength(exact), MAX_SOURCE_BYTES);
	assert.equal((await caseApi(new Response(exact)).getOpinion(opinionUrl)).kind, "found");
	const source = stream(Buffer.from(`${exact} `), { "content-length": "1" });
	assert.equal((await caseApi(source.response).getOpinion(opinionUrl)).kind, "malformed_response");
	assert.ok(source.cancelled());
});

test("invalid UTF-8 and an incomplete multi-byte sequence never become replacement-character evidence", async () => {
	for (const bytes of [Buffer.from([0x22, 0xc3, 0x28, 0x22]), Buffer.from([0x22, 0xc3])]) {
		assert.equal(await boundedJsonBody(new Response(bytes)), undefined);
	}
	assert.equal(
		(await caseApi(Response.json(opinion("\ud800"))).getOpinion(opinionUrl)).kind,
		"malformed_response",
	);
});

test("a stalled stream returns at cancellation even when cancellation acknowledgment never resolves", async () => {
	const source = stream(Buffer.from('{"id":456,'));
	const start = performance.now();
	assert.deepEqual(await caseApi(source.response, { timeoutMs: 30 }).getOpinion(opinionUrl), {
		kind: "unavailable",
		failure: "timeout",
	});
	assert.ok(source.cancelled());
	assert.ok(performance.now() - start < 1_000);
});

test("a transport that ignores abort cannot hang the caller or leave a late response unread", async () => {
	let finish;
	const late = stream(Buffer.from("unread"));
	const api = createCourtListenerCaseLawApi({
		token: "fixture-only",
		timeoutMs: 20,
		transport: () =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	});
	assert.deepEqual(await api.getOpinion(opinionUrl), { kind: "unavailable", failure: "timeout" });
	finish(late.response);
	await sleep(0);
	assert.ok(late.cancelled());
});

test("one aggregate budget spans citation, usage, and case-law API instances and stops new dispatch", async () => {
	const request = new EvidenceRequest({ maxBytes: 1024 });
	let calls = 0;
	try {
		const transport = async (source) => {
			calls++;
			const path = new URL(source.url).pathname;
			if (path.endsWith("/citation-lookup/"))
				return Response.json([
					{ status: 404, normalized_citations: ["347 U.S. 483"], clusters: [] },
				]);
			if (path.endsWith("/api-usage/")) return Response.json({ current_usage: [] });
			return Response.json(opinion("x".repeat(950)));
		};
		const citations = createCourtListenerApi({ request, token: "fixture-only", transport });
		const opinions = createCourtListenerCaseLawApi({ request, token: "fixture-only", transport });
		assert.equal((await citations.lookupCitation({ normalized: "347 U.S. 483" })).kind, "absent");
		await citations.getUsage();
		await opinions.getOpinion(opinionUrl);
		assert.equal(request.signal.reason.reason, "incomplete");
		assert.ok(request.responseBytes > 1024);
		await opinions.getOpinion(opinionUrl);
		assert.equal(calls, 3);
	} finally {
		request.close();
	}
});

test("real Node HTTP response body cancellation closes the upstream socket", async () => {
	let closeBody;
	const closed = new Promise((resolve) => {
		closeBody = resolve;
	});
	const server = createServer((_request, response) => {
		response.on("close", closeBody);
		response.writeHead(200, { "content-type": "application/json" });
		response.write('{"id":456,');
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	try {
		const api = createCourtListenerCaseLawApi({
			token: "fixture-only",
			timeoutMs: 150,
			transport: (request) =>
				fetch(new Request(`http://127.0.0.1:${server.address().port}/`, request)),
		});
		assert.deepEqual(await api.getOpinion(opinionUrl), { kind: "unavailable", failure: "timeout" });
		await closed;
	} finally {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	}
});

test("redirects are rejected without a second request", async () => {
	let calls = 0;
	const server = createServer((_request, response) => {
		calls++;
		response.writeHead(302, { location: "/another" });
		response.end();
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	try {
		const api = createCourtListenerCaseLawApi({
			token: "fixture-only",
			transport: (request) =>
				fetch(new Request(`http://127.0.0.1:${server.address().port}/`, request)),
		});
		assert.equal((await api.getOpinion(opinionUrl)).kind, "malformed_response");
		assert.equal(calls, 1);
	} finally {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	}
});

const citationGateway = {
	lookup: async () => ({
		kind: "verified",
		cluster,
		freshness: "fresh",
		retrievedAt: new Date().toISOString(),
	}),
};
test("cached source work cannot exceed the aggregate processing allowance or produce a negative", async () => {
	const request = new EvidenceRequest({ maxBytes: 100 });
	try {
		const result = await verifyQuote(
			{ citation: "347 U.S. 483", quote: "q".repeat(20) },
			citationGateway,
			{
				readCluster: async () => ({
					kind: "found",
					cluster: { ...cluster, opinionUrls: [opinionUrl, opinionUrl.replace("456", "457")] },
				}),
				readOpinion: async () => ({
					kind: "found",
					opinion: {
						id: 456,
						clusterId: 123,
						canonicalUrl: cluster.canonicalUrl,
						text: { plain_text: "a".repeat(64) },
						freshness: "fresh",
						retrievedAt: new Date().toISOString(),
					},
				}),
			},
			{ maxOpinions: 100, request },
		);
		assert.equal(result.outcome, "indeterminate");
		assert.equal(result.reason, "incomplete");
	} finally {
		request.close();
	}
});

test("citation and opinion lease polling stop after the request is cancelled", async () => {
	for (const kind of ["citation", "opinion"]) {
		const request = new EvidenceRequest({ timeoutMs: 30 });
		let reads = 0;
		const store = {
			read: async () => {
				reads++;
				return null;
			},
			acquireLease: async () => ({
				kind: "held",
				expiresAt: new Date(Date.now() + 10_000).toISOString(),
			}),
		};
		try {
			if (kind === "citation") {
				const gateway = createCachedCitationGateway({
					request,
					store,
					now: () => new Date(),
					ownerToken: () => "fixture",
					upstream: { lookup: () => assert.fail("Unexpected upstream request") },
				});
				const result = await verifyCitation({ citation: "347 U.S. 483" }, gateway, request);
				assert.equal(result.reason, "timeout");
			} else {
				await assert.rejects(
					request.run(() =>
						readCachedCaseLawOpinion(
							{ cluster, opinionUrl },
							{
								request,
								store,
								now: () => new Date(),
								token: () => "fixture",
								fetch: () => assert.fail("Unexpected upstream request"),
							},
						),
					),
					{ reason: "timeout" },
				);
			}
			const count = reads;
			await sleep(80);
			assert.equal(reads, count);
		} finally {
			request.close();
		}
	}
});

test("eight concurrent normalization requests preserve exact HTML semantics in two workers", async () => {
	const pool = new NodeOpinionNormalizer();
	try {
		const selected = {
			representation: "html_with_citations",
			content:
				"<p>“Equal <b>justice</b>” &amp; cafe\u0301—law.</p><script>ignored</script><p>Next</p>",
		};
		const outputs = await Promise.all(
			Array.from({ length: 8 }, () => pool.normalize(selected, signal())),
		);
		assert.deepEqual(outputs, Array(8).fill('"Equal justice" & café-law. Next'));
		assert.equal(pool.state.workers, 2);
		assert.equal(pool.state.queued, 0);
	} finally {
		await pool.close();
	}
	assert.equal(pool.state.workers, 0);
});

test("large ordinary HTML is bounded by actual nodes rather than appended text tokens", async () => {
	const pool = new NodeOpinionNormalizer();
	const paragraph = "Ordinary source language with no matching quotation in this passage.";
	try {
		const result = await pool.normalize(
			{ representation: "html", content: `<p>${paragraph}</p>`.repeat(12_000) },
			signal(),
		);
		assert.equal(result, Array(12_000).fill(paragraph).join(" "));
	} finally {
		await pool.close();
	}
});

test("excessive allocated HTML nodes cannot become a verified quote", async () => {
	const pool = new NodeOpinionNormalizer();
	try {
		await assert.rejects(
			pool.normalize({ representation: "html", content: "<i>x</i>".repeat(30_000) }, signal()),
			{ reason: "incomplete" },
		);
	} finally {
		await pool.close();
	}
});

test("normalization queue is finite and cancellation terminates actual busy CPU workers", async () => {
	const pool = new NodeOpinionNormalizer({
		workerUrl: new URL("./stalling-worker.mjs", import.meta.url),
	});
	const selected = { representation: "plain_text", content: "fixture" };
	const abort = new AbortController();
	try {
		assert.deepEqual(
			await Promise.all([pool.normalize(selected, signal()), pool.normalize(selected, signal())]),
			["CPU fault entered", "CPU fault entered"],
		);
		const pending = Array.from({ length: 8 }, () =>
			pool.normalize(selected, abort.signal).then(
				() => assert.fail("Busy worker unexpectedly completed"),
				(error) => error.reason,
			),
		);
		assert.deepEqual(pool.state, { workers: 2, active: 2, queued: 6 });
		await assert.rejects(pool.normalize(selected, signal()), { reason: "incomplete" });
		await sleep(20);
		abort.abort();
		assert.deepEqual(await Promise.all(pending), Array(8).fill("timeout"));
		assert.equal(pool.state.workers, 0);
	} finally {
		await pool.close();
	}
});

test("a normalization deadline terminates a CPU worker even without caller cancellation", async () => {
	const pool = new NodeOpinionNormalizer({
		workerUrl: new URL("./stalling-worker.mjs", import.meta.url),
		timeoutMs: 200,
	});
	try {
		const selected = { representation: "plain_text", content: "fixture" };
		assert.equal(await pool.normalize(selected, signal()), "CPU fault entered");
		await assert.rejects(pool.normalize(selected, signal()), { reason: "timeout" });
		assert.equal(pool.state.workers, 0);
	} finally {
		await pool.close();
	}
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { createPostgresCitationStore } from "../../build/postgres/citations.js";
import { PostgresOpinionSources } from "../../build/postgres/opinions.js";

export const marker = "Synthetic soak matching opinion sentence.";
export const missingQuote = "This deliberately absent sentence cannot be found.";
export const maximumQuote = "Q".repeat(10_000);
export const citation = (id) => `410 U.S. ${id}`;
const canonicalUrl = (id) => `https://www.courtlistener.com/opinion/${id}/fixture/`;
const megabyte = 1_048_576;

export async function prepareSoakSources(fixture, objects) {
	const citations = createPostgresCitationStore(fixture.database);
	const opinions = new PostgresOpinionSources(fixture.database, objects);
	const shapes = new Map([
		[
			101,
			{
				count: 100,
				text: (index) =>
					index === 98
						? `<p>${"<i>x</i>".repeat(24_998)}</p>`
						: `${"x".repeat(32_000)} ${index === 99 ? marker : "no match"}`,
				representation: (index) => (index === 98 ? "html" : "plain_text"),
			},
		],
		[
			102,
			{
				count: 1,
				text: () => `<p>${maximumQuote}${"z".repeat(megabyte - maximumQuote.length - 7)}</p>`,
				representation: "html",
			},
		],
		[103, { count: 17, text: () => "x".repeat(megabyte), representation: "plain_text" }],
		[104, { count: 1, mode: "oversized" }],
		[105, { count: 1, mode: "slow" }],
		[106, { count: 1, mode: "near-limit" }],
		[107, { count: 1, mode: "kill" }],
		[108, { count: 101, mode: "too-many" }],
	]);
	for (const [id, shape] of shapes) {
		const ownerToken = randomUUID();
		const input = { normalizedCitation: citation(id), ownerToken, now: new Date() };
		assert.equal((await citations.acquireLease(input)).kind, "acquired");
		assert.equal(
			(
				await citations.fillLease({
					...input,
					observation: { kind: "positive", cluster: { id, canonicalUrl: canonicalUrl(id) } },
				})
			).kind,
			"stored",
		);
		if (!shape.text) continue;
		for (let index = 0; index < shape.count; index++) {
			const opinionId = id * 1000 + index;
			const token = randomUUID();
			assert.equal(
				(await opinions.acquireLease({ opinionId, ownerToken: token, now: new Date() })).kind,
				"acquired",
			);
			assert.equal(
				(
					await opinions.fillLease({
						ownerToken: token,
						now: new Date(),
						observation: {
							kind: "positive",
							provenance: { opinionId, clusterId: id, canonicalUrl: canonicalUrl(id) },
							representation:
								typeof shape.representation === "function"
									? shape.representation(index)
									: shape.representation,
							sourceText: shape.text(index),
						},
					})
				).kind,
				"stored",
			);
		}
	}
	const state = { requests: [], failures: 0, killStarted: false, releaseKill: false, active: 0 };
	const server = createServer((request, response) => {
		state.active++;
		response.on("close", () => state.active--);
		void (async () => {
			assert.equal(request.headers.authorization, "Token synthetic-soak-upstream-token");
			const path = new URL(request.url, "http://fixture").pathname;
			const usage = path.endsWith("api-usage/");
			// A real SQL reservation must precede every fixture HTTP dispatch.
			const pending = await fixture.migration.query(
				"SELECT count(*)::integer AS count FROM lexcerta.upstream_attempts WHERE completed_at IS NULL AND kind = $1",
				[usage ? "quota_sync" : "case_law"],
			);
			assert.ok(pending.rows[0].count > 0);
			state.requests.push({ path, usage, received_at: new Date().toISOString() });
			let body;
			if (usage)
				body = {
					current_usage: ["user", "citations", "api_usage"].map((scope) => ({
						scope,
						rate: "day",
						used: 0,
						limit: 10000,
						remaining: 10000,
						window_seconds: 86400,
						reset_at: null,
						blocked: false,
					})),
				};
			else {
				const match = /\/(clusters|opinions)\/(\d+)\/$/.exec(path);
				assert.ok(match);
				const id = Number(match[2]);
				const clusterId = match[1] === "clusters" ? id : Math.floor(id / 1000);
				const shape = shapes.get(clusterId);
				assert.ok(shape);
				if (match[1] === "clusters")
					body = {
						id,
						absolute_url: `/opinion/${id}/fixture/`,
						sub_opinions: Array.from(
							{ length: shape.count },
							(_, index) =>
								`https://www.courtlistener.com/api/rest/v4/opinions/${id * 1000 + index}/`,
						),
					};
				else {
					if (shape.mode === "kill" && !state.releaseKill) {
						state.killStarted = true;
						return;
					}
					if (shape.mode === "slow") {
						response.writeHead(200, { "content-type": "application/json" });
						response.write('{"plain_text":"');
						return;
					}
					body = { id, cluster_id: clusterId, plain_text: marker };
					if (shape.mode === "oversized" || shape.mode === "near-limit") {
						const target = megabyte + (shape.mode === "oversized" ? 1 : 0);
						body.plain_text += "x".repeat(target - Buffer.byteLength(JSON.stringify(body)));
						assert.equal(Buffer.byteLength(JSON.stringify(body)), target);
					}
				}
			}
			if (!response.destroyed) {
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify(body));
			}
		})().catch(() => {
			state.failures++;
			response.destroy();
		});
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return {
		state,
		port: server.address().port,
		close: async () => {
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		},
	};
}

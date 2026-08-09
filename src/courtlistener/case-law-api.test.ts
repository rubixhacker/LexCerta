import { describe, expect, it } from "vitest";
import {
	type CourtListenerCaseLawTransport,
	createCourtListenerCaseLawApi,
} from "./case-law-api.js";

const CLUSTER_URL = "https://www.courtlistener.com/api/rest/v4/clusters/123/";
const OPINION_URL = "https://www.courtlistener.com/api/rest/v4/opinions/456/";

function givenTransport(responses: readonly Response[]) {
	const pending = [...responses];
	const requests: Request[] = [];
	const transport: CourtListenerCaseLawTransport = async (request) => {
		requests.push(request);
		const response = pending.shift();
		if (response === undefined) throw new RangeError("unexpected request");
		return response;
	};
	return { requests, transport };
}

describe("CourtListener case-law REST adapter", () => {
	it("retrieves a trusted cluster and its linked opinion with Token authentication", async () => {
		// Given: bounded CourtListener cluster and opinion records with trusted IDs and relation URLs.
		const given = givenTransport([
			new Response(
				JSON.stringify({
					id: 123,
					absolute_url: "/opinion/123/example/",
					sub_opinions: [OPINION_URL],
				}),
			),
			new Response(
				JSON.stringify({
					id: 456,
					cluster: CLUSTER_URL,
					html_with_citations: "<p>Canonical source</p>",
					html: "<p>Fallback source</p>",
					plain_text: "Fallback source",
				}),
			),
		]);
		const api = createCourtListenerCaseLawApi({
			token: "fixture-token",
			transport: given.transport,
		});

		// When: the cluster and its linked opinion are retrieved once each.
		const cluster = await api.getCluster(123);
		const opinion = await api.getOpinion(OPINION_URL);

		// Then: only safe metadata/source fields cross the adapter boundary on authenticated GETs.
		expect(cluster).toEqual({
			kind: "found",
			cluster: {
				id: 123,
				canonicalUrl: "https://www.courtlistener.com/opinion/123/example/",
				subOpinions: [{ id: 456, url: OPINION_URL }],
			},
		});
		expect(opinion).toEqual({
			kind: "found",
			opinion: {
				clusterId: 123,
				id: 456,
				html: "<p>Fallback source</p>",
				htmlWithCitations: "<p>Canonical source</p>",
				plainText: "Fallback source",
			},
		});
		expect(given.requests.map((request) => request.url)).toEqual([CLUSTER_URL, OPINION_URL]);
		expect(given.requests.map((request) => request.headers.get("authorization"))).toEqual([
			"Token fixture-token",
			"Token fixture-token",
		]);
	});

	it("rejects an untrusted sub-opinion relation without following it", async () => {
		// Given: a cluster body that tries to redirect opinion retrieval off CourtListener.
		const given = givenTransport([
			new Response(
				JSON.stringify({
					id: 123,
					absolute_url: "/opinion/123/example/",
					sub_opinions: ["https://untrusted.example/opinions/456/"],
				}),
			),
		]);

		// When: the cluster is retrieved.
		const result = await createCourtListenerCaseLawApi({
			token: "fixture-token",
			transport: given.transport,
		}).getCluster(123);

		// Then: parsing fails closed and no untrusted opinion request occurs.
		expect(result).toEqual({ kind: "malformed_response" });
		expect(given.requests).toHaveLength(1);
	});

	it("rejects a cluster body whose ID differs from the requested path", async () => {
		// Given: the trusted cluster path requests 123 but the response body claims a different cluster.
		const given = givenTransport([
			new Response(
				JSON.stringify({
					absolute_url: "/opinion/999/example/",
					id: 999,
					sub_opinions: [],
				}),
			),
		]);

		// When: the configured API retrieves cluster 123.
		const result = await createCourtListenerCaseLawApi({
			token: "fixture-token",
			transport: given.transport,
		}).getCluster(123);

		// Then: mismatched cluster identity cannot become source provenance.
		expect(result).toEqual({ kind: "malformed_response" });
	});

	it("honors configured cluster and source processing bounds", async () => {
		// Given: a two-opinion cluster and an opinion representation above configured ceilings.
		const cluster = givenTransport([
			new Response(
				JSON.stringify({
					absolute_url: "/opinion/123/example/",
					id: 123,
					sub_opinions: [OPINION_URL, "https://www.courtlistener.com/api/rest/v4/opinions/457/"],
				}),
			),
		]);
		const opinion = givenTransport([
			new Response(JSON.stringify({ cluster: CLUSTER_URL, id: 456, plain_text: "12345" })),
		]);

		// When: each response exceeds its independently configured processing bound.
		const clusterResult = await createCourtListenerCaseLawApi({
			maxOpinionsPerCluster: 1,
			token: "fixture-token",
			transport: cluster.transport,
		}).getCluster(123);
		const opinionResult = await createCourtListenerCaseLawApi({
			maxSourceCharacters: 4,
			token: "fixture-token",
			transport: opinion.transport,
		}).getOpinion(OPINION_URL);

		// Then: neither boundary becomes a usable source record or a retry.
		expect(clusterResult).toEqual({ kind: "malformed_response" });
		expect(opinionResult).toEqual({ kind: "malformed_response" });
		expect(cluster.requests).toHaveLength(1);
		expect(opinion.requests).toHaveLength(1);
	});

	it("maps a failed opinion attempt to a sanitized typed outcome without retrying", async () => {
		// Given: the sole opinion request receives an upstream server failure.
		const given = givenTransport([new Response("private upstream body", { status: 503 })]);

		// When: that known-safe opinion URL is retrieved.
		const result = await createCourtListenerCaseLawApi({
			token: "fixture-token",
			transport: given.transport,
		}).getOpinion(OPINION_URL);

		// Then: the failure is classified without leaking the upstream body or making a retry.
		expect(result).toEqual({ kind: "unavailable", failure: "server", status: 503 });
		expect(given.requests).toHaveLength(1);
	});

	it("rejects an opinion body whose ID does not match the trusted relation URL", async () => {
		// Given: the trusted relationship names opinion 456 but its response body claims a different ID.
		const given = givenTransport([
			new Response(
				JSON.stringify({
					cluster: CLUSTER_URL,
					id: 457,
					plain_text: "Wrong opinion identity",
				}),
			),
		]);

		// When: that relationship is retrieved.
		const result = await createCourtListenerCaseLawApi({
			token: "fixture-token",
			transport: given.transport,
		}).getOpinion(OPINION_URL);

		// Then: it cannot cross the trust boundary as an opinion record.
		expect(result).toEqual({ kind: "malformed_response" });
		expect(given.requests).toHaveLength(1);
	});
});

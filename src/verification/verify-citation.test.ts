import { describe, expect, it } from "vitest";
import {
	CONTRACT_VERSION,
	type CitationVerificationGateway,
	verifyCitation,
	verifyCitationInputSchema,
	verifyCitationOutputSchema,
	verifyCitationToolDefinition,
} from "./verify-citation.js";

const retrievalTime = "2026-08-09T15:30:00.000Z";

function gatewayThat(observation: Awaited<ReturnType<CitationVerificationGateway["lookup"]>>): {
	readonly gateway: CitationVerificationGateway;
	readonly calls: readonly unknown[];
} {
	const calls: unknown[] = [];
	return {
		gateway: {
			async lookup(query) {
				calls.push(query);
				return observation;
			},
		},
		calls,
	};
}

describe("verifyCitation", () => {
	it("returns fresh, metadata-only CourtListener provenance for a supported citation", async () => {
		const { gateway } = gatewayThat({
			kind: "verified",
			cluster: {
				id: 12345,
				canonicalUrl: "https://www.courtlistener.com/opinion/12345/example/",
			},
			freshness: "fresh",
			retrievedAt: retrievalTime,
		});

		const result = await verifyCitation({ citation: "347 us 483, 490 (1954)" }, gateway);

		expect(result).toEqual({
			outcome: "verified",
			contractVersion: CONTRACT_VERSION,
			evidence: {
				source: "courtlistener",
				normalizedCitation: "347 U.S. 483",
				retrievedAt: retrievalTime,
				freshness: "fresh",
				cluster: {
					id: 12345,
					canonicalUrl: "https://www.courtlistener.com/opinion/12345/example/",
				},
			},
		});
		expect(JSON.stringify(result)).not.toContain("490 (1954)");
	});

	it("returns source-scoped absence only after a successful CourtListener lookup", async () => {
		const { gateway, calls } = gatewayThat({ kind: "not_found", retrievedAt: retrievalTime });

		const result = await verifyCitation({ citation: "1 U.S. 200" }, gateway);

		expect(result).toEqual({
			outcome: "not_found",
			contractVersion: CONTRACT_VERSION,
			evidence: {
				source: "courtlistener",
				normalizedCitation: "1 U.S. 200",
				retrievedAt: retrievalTime,
				freshness: "fresh",
				searchComplete: true,
			},
		});
		expect(calls).toHaveLength(1);
	});

	it("discloses retained positive evidence as stale after failed revalidation", async () => {
		// Given: a cache gateway that retained positive evidence beyond its freshness window.
		const { gateway } = gatewayThat({
			kind: "verified",
			cluster: {
				id: 12345,
				canonicalUrl: "https://www.courtlistener.com/opinion/12345/example/",
			},
			freshness: "stale",
			retrievedAt: retrievalTime,
		});

		// When: a supported citation is verified from that retained evidence.
		const result = await verifyCitation({ citation: "347 U.S. 483" }, gateway);

		// Then: the original retrieval time is disclosed without a silent fresh claim.
		expect(result).toMatchObject({
			outcome: "verified",
			evidence: { freshness: "stale", retrievedAt: retrievalTime },
		});
	});

	it("returns unsupported_citation locally without contacting the gateway", async () => {
		const { gateway, calls } = gatewayThat({ kind: "not_found", retrievedAt: retrievalTime });

		const result = await verifyCitation({ citation: "not a citation" }, gateway);

		expect(result).toEqual({
			outcome: "indeterminate",
			contractVersion: CONTRACT_VERSION,
			reason: "unsupported_citation",
			retry: { action: "use_supported_citation" },
		});
		expect(calls).toHaveLength(0);
	});

	it.each([
		["incomplete", undefined],
		["timeout", undefined],
		["upstream_unavailable", undefined],
		["quota_unknown", undefined],
		["source_changed", undefined],
		["rate_limited", 60],
		["circuit_open", 30],
	] as const)("maps %s to sanitized retry guidance", async (reason, retryAfterSeconds) => {
		const { gateway } = gatewayThat({
			kind: "indeterminate",
			reason,
			...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
		});

		const result = await verifyCitation({ citation: "347 U.S. 483" }, gateway);

		expect(result).toEqual({
			outcome: "indeterminate",
			contractVersion: CONTRACT_VERSION,
			reason,
			retry: {
				action: "retry_later",
				...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
			},
		});
	});
});

describe("verify_citation contract schemas", () => {
	it("bounds the citation input and accepts only the v1 output variants", () => {
		expect(verifyCitationInputSchema.safeParse({ citation: "x" }).success).toBe(true);
		expect(verifyCitationInputSchema.safeParse({ citation: "x".repeat(256) }).success).toBe(true);
		expect(verifyCitationInputSchema.safeParse({ citation: "" }).success).toBe(false);
		expect(verifyCitationInputSchema.safeParse({ citation: "x".repeat(257) }).success).toBe(false);
		expect(
			verifyCitationOutputSchema.safeParse({
				outcome: "verified",
				contractVersion: CONTRACT_VERSION,
				evidence: {
					source: "courtlistener",
					normalizedCitation: "347 U.S. 483",
					retrievedAt: retrievalTime,
					freshness: "fresh",
					cluster: {
						id: 12345,
						canonicalUrl: "https://www.courtlistener.com/opinion/12345/example/",
					},
				},
			}).success,
		).toBe(true);
		expect(
			verifyCitationOutputSchema.safeParse({
				outcome: "verified",
				contractVersion: CONTRACT_VERSION,
				evidence: {
					source: "courtlistener",
					normalizedCitation: "347 U.S. 483",
					retrievedAt: retrievalTime,
					freshness: "stale",
					cluster: {
						id: 12345,
						canonicalUrl: "https://www.courtlistener.com/opinion/12345/example/",
					},
				},
			}).success,
		).toBe(true);
		expect(
			verifyCitationOutputSchema.safeParse({
				outcome: "indeterminate",
				contractVersion: CONTRACT_VERSION,
				reason: "source_changed",
				retry: { action: "retry_later" },
			}).success,
		).toBe(true);
		expect(
			verifyCitationOutputSchema.safeParse({
				outcome: "rate_limited",
				contractVersion: CONTRACT_VERSION,
			}).success,
		).toBe(false);
		expect(
			verifyCitationOutputSchema.safeParse({
				outcome: "not_found",
				contractVersion: CONTRACT_VERSION,
				evidence: {
					source: "courtlistener",
					normalizedCitation: "1 U.S. 200",
					retrievedAt: retrievalTime,
					freshness: "fresh",
				},
			}).success,
		).toBe(false);
		expect(
			verifyCitationOutputSchema.safeParse({
				outcome: "verified",
				contractVersion: CONTRACT_VERSION,
				evidence: {
					source: "courtlistener",
					normalizedCitation: "347 U.S. 483",
					retrievedAt: retrievalTime,
					freshness: "live",
					cluster: { id: 12345, canonicalUrl: "https://example.com/opinion/12345/" },
				},
			}).success,
		).toBe(false);
		expect(
			verifyCitationOutputSchema.safeParse({
				outcome: "indeterminate",
				contractVersion: CONTRACT_VERSION,
				reason: "timeout",
				retry: { action: "retry_later", retryAfterSeconds: 60 },
			}).success,
		).toBe(false);
	});

	it("declares verify_citation as a read-only, idempotent tool", () => {
		expect(verifyCitationToolDefinition.annotations).toEqual({
			title: "Verify citation",
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		});
	});
});

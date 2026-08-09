import { env } from "cloudflare:test";
import { beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import migration from "../migrations/0005_opinion_source_cache.sql?raw";
import { createD1R2OpinionCacheStore } from "../src/cache/d1-r2-opinion-cache-store.js";
import type { OpinionLeaseFillResult } from "../src/cache/opinion-cache-store.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");

async function reset(): Promise<void> {
	await env.DB.prepare("DROP TABLE IF EXISTS opinion_fetch_leases").run();
	await env.DB.prepare("DROP TABLE IF EXISTS opinion_source_metadata").run();
	for (const statement of migration
		.split(";")
		.map((value) => value.trim())
		.filter(Boolean)) {
		await env.DB.prepare(statement).run();
	}
}

describe("D1/R2 opinion cache lease release", () => {
	beforeEach(reset);

	it("allows only the active owner to release a lease", async () => {
		// Given: a single active opinion fetch lease.
		const store = createD1R2OpinionCacheStore({ database: env.DB, opinions: env.OPINIONS });
		await store.acquireLease({ opinionId: 456, ownerToken: "owner-a", now: NOW });

		// When: a different token tries to release it before the owner does.
		const other = await store.releaseLease({ opinionId: 456, ownerToken: "owner-b" });
		const owner = await store.releaseLease({ opinionId: 456, ownerToken: "owner-a" });

		// Then: only the owner release enables the next contender to fetch.
		expect(other).toEqual({ kind: "lease_unavailable" });
		expect(owner).toEqual({ kind: "released" });
		await expect(
			store.acquireLease({ opinionId: 456, ownerToken: "owner-b", now: NOW }),
		).resolves.toMatchObject({ kind: "acquired" });
	});

	it("cannot encode an indeterminate operational result as a durable fill", () => {
		// Given: the public fill-result contract.
		expectTypeOf<OpinionLeaseFillResult>().not.toMatchTypeOf<{
			readonly kind: "indeterminate";
		}>();

		// When: a caller supplies a fill result to TypeScript.
		const durable: OpinionLeaseFillResult = { kind: "lease_unavailable" };

		// Then: only a successful store or unavailable lease is representable.
		expect(durable).toEqual({ kind: "lease_unavailable" });
	});
});

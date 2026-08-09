import { purgeExpiredOpinionNegative } from "../verification/opinion-source-cache.js";
import type { OpinionSourceCacheState } from "../verification/opinion-source-cache.js";
import { OpinionSourceCacheCorruptError } from "./opinion-source-record.js";
import type { OpinionSourceLeasePurgeResult } from "./opinion-source-store.js";

export async function purgeExpiredNegativeLease(
	database: D1Database,
	input: {
		readonly expected: Extract<OpinionSourceCacheState, { readonly kind: "negative" }>;
		readonly now: Date;
		readonly opinionId: number;
		readonly ownerToken: string;
	},
): Promise<OpinionSourceLeasePurgeResult> {
	const next = purgeExpiredOpinionNegative({ now: input.now, state: input.expected });
	const now = input.now.toISOString();
	const result =
		next.kind === "empty"
			? await database
					.prepare(
						"DELETE FROM opinion_source_states WHERE opinion_id = ?1 AND state_json = ?2 AND EXISTS (SELECT 1 FROM opinion_source_fetch_leases WHERE opinion_id = ?1 AND owner_token = ?3 AND expires_at > ?4)",
					)
					.bind(input.opinionId, JSON.stringify(input.expected), input.ownerToken, now)
					.run()
			: await database
					.prepare(
						"UPDATE opinion_source_states SET state_json = ?1, updated_at = ?2 WHERE opinion_id = ?3 AND state_json = ?4 AND EXISTS (SELECT 1 FROM opinion_source_fetch_leases WHERE opinion_id = ?3 AND owner_token = ?5 AND expires_at > ?2)",
					)
					.bind(
						JSON.stringify(next),
						now,
						input.opinionId,
						JSON.stringify(input.expected),
						input.ownerToken,
					)
					.run();
	if (changes(result) === 1) return { kind: "purged", state: next.kind === "empty" ? null : next };
	return (await ownsActiveLease(database, input.opinionId, input.ownerToken, now))
		? { kind: "state_changed" }
		: { kind: "lease_unavailable" };
}

async function ownsActiveLease(
	database: D1Database,
	opinionId: number,
	ownerToken: string,
	now: string,
): Promise<boolean> {
	const row = await database
		.prepare(
			"SELECT 1 FROM opinion_source_fetch_leases WHERE opinion_id = ?1 AND owner_token = ?2 AND expires_at > ?3",
		)
		.bind(opinionId, ownerToken, now)
		.first<unknown>();
	return row !== null;
}

function changes(result: D1Result<unknown> | undefined): number {
	const value = result?.meta.changes;
	if (typeof value !== "number") throw new OpinionSourceCacheCorruptError();
	return value;
}

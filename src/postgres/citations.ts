import {
	parseCitationSourceState,
	requireStoredState,
} from "../cache/citation-observation-state.js";
import type { CitationObservationStore } from "../cache/citation-observation-store.js";
import {
	initialCitationSourceCacheState,
	purgeExpiredCitationNegative,
	recordCitationSourceObservation,
} from "../verification/citation-source-cache.js";
import type { PgDatabase, PgTransaction } from "./database.js";

type SourceRow = {
	state: unknown;
	epoch: string;
	owner_token: string | null;
	lease_expires_at: Date | null;
};

export function createPostgresCitationStore(database: PgDatabase): CitationObservationStore {
	return {
		read: async ({ normalizedCitation }) =>
			database.transaction(async (transaction) => {
				const result = await transaction.query<SourceRow>(
					"SELECT state FROM lexcerta.citation_sources WHERE citation = $1",
					[normalizedCitation],
				);
				return parse(result.rows[0]?.state);
			}),
		acquireLease: async ({ normalizedCitation, ownerToken }) =>
			database.transaction(async (transaction) => {
				await transaction.query(
					"INSERT INTO lexcerta.citation_sources(citation) VALUES ($1) ON CONFLICT DO NOTHING",
					[normalizedCitation],
				);
				const row = await lock(transaction, normalizedCitation);
				const now = await transaction.now();
				if (row.lease_expires_at !== null && row.lease_expires_at > now)
					return { kind: "held", expiresAt: row.lease_expires_at.toISOString() };
				const expires = new Date(now.getTime() + 10_000);
				await transaction.query(
					"UPDATE lexcerta.citation_sources SET epoch = epoch + 1, owner_token = $2, lease_expires_at = $3 WHERE citation = $1",
					[normalizedCitation, ownerToken, expires],
				);
				return { kind: "acquired", expiresAt: expires.toISOString() };
			}),
		fillLease: async ({ normalizedCitation, ownerToken, observation }) =>
			database.transaction(async (transaction) => {
				const row = await lock(transaction, normalizedCitation);
				const now = await transaction.now();
				if (!owns(row, ownerToken, now)) return { kind: "lease_unavailable" };
				const state = requireStoredState(
					recordCitationSourceObservation({
						state: parse(row.state) ?? initialCitationSourceCacheState(),
						observation,
						now,
					}),
				);
				const serialized = JSON.stringify(state);
				parseCitationSourceState(serialized);
				await transaction.query(
					"UPDATE lexcerta.citation_sources SET state = $2, owner_token = NULL, lease_expires_at = NULL, updated_at = $3 WHERE citation = $1 AND epoch = $4",
					[normalizedCitation, serialized, now, row.epoch],
				);
				return { kind: "stored", observation: state };
			}),
		purgeExpiredNegativeLease: async ({ normalizedCitation, ownerToken, expected }) =>
			database.transaction(async (transaction) => {
				const row = await lock(transaction, normalizedCitation);
				const now = await transaction.now();
				if (!owns(row, ownerToken, now)) return { kind: "lease_unavailable" };
				const current = parse(row.state);
				if (JSON.stringify(current) !== JSON.stringify(expected)) return { kind: "state_changed" };
				const state = purgeExpiredCitationNegative({ state: expected, now });
				await transaction.query(
					"UPDATE lexcerta.citation_sources SET state = $2, updated_at = $3 WHERE citation = $1 AND epoch = $4",
					[
						normalizedCitation,
						state.kind === "empty" ? null : JSON.stringify(state),
						now,
						row.epoch,
					],
				);
				return { kind: "purged", observation: state.kind === "empty" ? null : state };
			}),
		releaseLease: async ({ normalizedCitation, ownerToken }) =>
			database.transaction(async (transaction) => {
				const result = await transaction.query(
					"UPDATE lexcerta.citation_sources SET owner_token = NULL, lease_expires_at = NULL WHERE citation = $1 AND owner_token = $2",
					[normalizedCitation, ownerToken],
				);
				return result.rowCount === 1 ? { kind: "released" } : { kind: "lease_unavailable" };
			}),
	};
}

function parse(value: unknown) {
	return value === null || value === undefined
		? null
		: parseCitationSourceState(JSON.stringify(value));
}
async function lock(transaction: PgTransaction, citation: string): Promise<SourceRow> {
	const row = (
		await transaction.query<SourceRow>(
			"SELECT state, epoch, owner_token, lease_expires_at FROM lexcerta.citation_sources WHERE citation = $1 FOR UPDATE",
			[citation],
		)
	).rows[0];
	if (row === undefined) throw new Error("citation source authority unavailable");
	return row;
}
function owns(row: SourceRow, owner: string, now: Date): boolean {
	return row.owner_token === owner && row.lease_expires_at !== null && row.lease_expires_at > now;
}

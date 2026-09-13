import { parseCitationSourceState } from "../cache/citation-observation-state.js";
import {
	parseOpinionSourceState,
	validateOpinionSourceState,
} from "../cache/opinion-source-record.js";
import { purgeExpiredCitationNegative } from "../verification/citation-source-cache.js";
import { purgeExpiredOpinionNegative } from "../verification/opinion-source-cache.js";
import type { TransactionDatabase } from "./database.js";
import type { MaintenanceLease, MaintenanceProgress } from "./maintenance.js";
import type { SourceObjects } from "./objects.js";
import { PostgresOpinionSources } from "./opinions.js";
import { purgePostgresRetention, purgePostgresRollingWindows } from "./retention.js";

type StepResult = {
	readonly changed: number;
	readonly blocked: boolean;
	readonly completed: MaintenanceProgress["name"] | null;
};

async function pendingRetention(database: TransactionDatabase, lifecycle: boolean) {
	return database.transaction(async (transaction) => {
		const windows = await transaction.query<{ pending: boolean }>(`
			SELECT EXISTS (SELECT 1 FROM lexcerta.key_admissions WHERE admitted_at <= clock_timestamp() - interval '48 hours')
			OR EXISTS (SELECT 1 FROM lexcerta.upstream_attempts WHERE reserved_at <= clock_timestamp() - interval '48 hours') AS pending
		`);
		if (windows.rows[0]?.pending !== false) return true;
		if (!lifecycle) return false;
		const result = await transaction.query<{ pending: boolean }>(`
			SELECT EXISTS (SELECT 1 FROM lexcerta.admin_audit_events WHERE retention_expires_at <= clock_timestamp())
			OR EXISTS (SELECT 1 FROM lexcerta.api_keys WHERE retention_expires_at <= clock_timestamp() AND (status = 'revoked' OR expires_at <= clock_timestamp()))
			OR EXISTS (SELECT 1 FROM lexcerta.customers c WHERE (retired_at IS NULL OR retention_expires_at <= clock_timestamp())
				AND NOT EXISTS (SELECT 1 FROM lexcerta.api_keys k WHERE k.customer_id = c.id)
				AND NOT EXISTS (SELECT 1 FROM lexcerta.admin_audit_events a WHERE a.customer_id = c.id)) AS pending
		`);
		return result.rows[0]?.pending !== false;
	});
}

export async function advanceMaintenance(
	lease: MaintenanceLease,
	progress: MaintenanceProgress,
	objects: SourceObjects,
	objectBudgetMs = 30_000,
): Promise<StepResult> {
	const database = lease.database;
	if (progress.stage === "retention") {
		const counts =
			progress.name === "cleanup"
				? await purgePostgresRollingWindows(database)
				: await purgePostgresRetention(database);
		const changed = Object.values(counts).reduce((sum, count) => sum + count, 0);
		const pending = await pendingRetention(database, progress.name === "lifecycle");
		if (!pending)
			await lease.checkpoint(
				progress,
				progress.name === "cleanup" ? { kind: "complete" } : { kind: "stage", stage: "citations" },
			);
		return {
			changed,
			blocked: pending && changed === 0,
			completed: !pending && progress.name === "cleanup" ? "cleanup" : null,
		};
	}
	if (progress.stage === "citations" || progress.stage === "opinions") {
		const sweep =
			progress.stage === "citations"
				? await purgeCitationPage(database, progress.citation_cursor)
				: await purgeOpinionPage(database, progress.opinion_cursor);
		await lease.checkpoint(progress, {
			kind: "stage",
			stage: sweep.complete
				? progress.stage === "citations"
					? "opinions"
					: "objects"
				: progress.stage,
			cursor: sweep.complete ? null : sweep.cursor,
		});
		return { changed: sweep.changed, blocked: sweep.blocked, completed: null };
	}
	const sources = new PostgresOpinionSources(database, objects);
	if (progress.stage === "objects") {
		const changed = await sources.collectGarbage(10, false, objectBudgetMs);
		const pending = await sources.hasPendingGarbage();
		if (!pending) await lease.checkpoint(progress, { kind: "stage", stage: "orphans" });
		return { changed, blocked: pending && changed === 0, completed: null };
	}
	const page = await sources.collectOrphans(
		progress.orphan_page_token ?? undefined,
		objectBudgetMs,
		progress.orphan_after_key === null || progress.orphan_after_generation === null
			? undefined
			: { key: progress.orphan_after_key, generation: progress.orphan_after_generation },
	);
	await lease.checkpoint(
		progress,
		page.complete
			? { kind: "complete" }
			: { kind: "stage", stage: "orphans", cursor: page.nextPageToken, after: page.after },
	);
	return {
		changed: page.deleted,
		blocked:
			!page.complete &&
			page.deleted === 0 &&
			page.nextPageToken === progress.orphan_page_token &&
			(page.after?.key ?? null) === progress.orphan_after_key &&
			(page.after?.generation ?? null) === progress.orphan_after_generation,
		completed: page.complete ? "lifecycle" : null,
	};
}

async function purgeCitationPage(database: TransactionDatabase, cursor: string | null) {
	return database.transaction(async (transaction) => {
		const result = await transaction.query<{
			citation: string;
			state: unknown;
			lease_expires_at: Date | null;
		}>(
			"SELECT citation, state, lease_expires_at FROM lexcerta.citation_sources WHERE state->>'kind' = 'negative' AND ($1::text IS NULL OR citation > $1) ORDER BY citation LIMIT 100 FOR UPDATE",
			[cursor],
		);
		const now = await transaction.now();
		let changed = 0;
		let next = cursor;
		for (const row of result.rows) {
			const state = parseCitationSourceState(JSON.stringify(row.state));
			const purged = purgeExpiredCitationNegative({ state, now });
			if (purged !== state) {
				if (row.lease_expires_at !== null && row.lease_expires_at > now)
					return { changed, cursor: next, complete: false, blocked: true };
				await transaction.query(
					"UPDATE lexcerta.citation_sources SET state = $2, updated_at = $3 WHERE citation = $1",
					[row.citation, purged.kind === "empty" ? null : JSON.stringify(purged), now],
				);
				changed += 1;
			}
			next = row.citation;
		}
		return { changed, cursor: next, complete: result.rows.length < 100, blocked: false };
	});
}

async function purgeOpinionPage(database: TransactionDatabase, cursor: string | null) {
	return database.transaction(async (transaction) => {
		const result = await transaction.query<{
			opinion_id: string;
			state: unknown;
			lease_expires_at: Date | null;
		}>(
			"SELECT opinion_id, state, lease_expires_at FROM lexcerta.opinion_sources WHERE state->>'kind' = 'negative' AND ($1::bigint IS NULL OR opinion_id > $1) ORDER BY opinion_id LIMIT 100 FOR UPDATE",
			[cursor],
		);
		const now = await transaction.now();
		let changed = 0;
		let next = cursor;
		for (const row of result.rows) {
			const state = parseOpinionSourceState({ state_json: JSON.stringify(row.state) });
			if (
				state.kind !== "negative" ||
				String(state.negative.provenance.opinionId) !== row.opinion_id
			)
				throw new Error("opinion maintenance state unavailable");
			validateOpinionSourceState(state, state.negative.provenance);
			const purged = purgeExpiredOpinionNegative({ state, now });
			if (purged !== state) {
				if (row.lease_expires_at !== null && row.lease_expires_at > now)
					return { changed, cursor: next, complete: false, blocked: true };
				await transaction.query(
					"UPDATE lexcerta.opinion_sources SET state = $2, body_key = NULL, updated_at = $3 WHERE opinion_id = $1",
					[row.opinion_id, purged.kind === "empty" ? null : JSON.stringify(purged), now],
				);
				changed += 1;
			}
			next = row.opinion_id;
		}
		return { changed, cursor: next, complete: result.rows.length < 100, blocked: false };
	});
}

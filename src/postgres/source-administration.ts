import { z } from "zod";
import type { PgDatabase } from "./database.js";
import { RecoveryJournalUnavailable, type RecoveryJournalWriter } from "./recovery-journal.js";

export class PostgresSourceAdministration {
	constructor(
		private readonly database: PgDatabase,
		private readonly environment: "production" | "test",
		private readonly journal: RecoveryJournalWriter,
		private readonly signal?: AbortSignal,
	) {
		if (journal.environment !== (environment === "production" ? "production" : "staging"))
			throw new RecoveryJournalUnavailable();
	}

	async remove(opinionId: number, actorSubject: string) {
		z.number().int().positive().safe().parse(opinionId);
		z.string().min(1).max(256).parse(actorSubject);
		try {
			await this.journal.append({ kind: "remove_opinion", opinionId }, this.signal);
			return await this.database.transaction(async (transaction) => {
				const result = await transaction.query<{ removed_at: Date; pending_deletions: number }>(
					"SELECT removed_at, pending_deletions FROM lexcerta.remove_opinion($1, $2, $3)",
					[opinionId, actorSubject, this.environment],
				);
				const row = result.rows[0];
				if (
					!row ||
					!(row.removed_at instanceof Date) ||
					!Number.isFinite(row.removed_at.getTime()) ||
					!Number.isSafeInteger(row.pending_deletions) ||
					row.pending_deletions < 0
				)
					throw new RecoveryJournalUnavailable();
				return {
					opinionId,
					status: "removed" as const,
					removedAt: row.removed_at.toISOString(),
					pendingDeletionObjects: row.pending_deletions,
				};
			});
		} catch {
			// The journal or SQL may already have committed. Repeating this same
			// removal is safe; no outcome permits cancelling the restriction.
			throw new RecoveryJournalUnavailable();
		}
	}
}

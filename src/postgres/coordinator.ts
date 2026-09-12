import {
	type BudgetDecision,
	type CourtListenerBudgetState,
	type QuotaSyncStart,
	admitCourtListenerRequest,
	beginQuotaSync,
	failQuotaSync,
	initialCourtListenerBudgetState,
	recordCourtListenerOutcome,
	recordQuotaSync,
	recordQuotaSyncRateLimited,
} from "../courtlistener/budget.js";
import {
	type CourtListenerCoordinatorAdmission,
	type CourtListenerCoordinatorOutcome,
	type CourtListenerCoordinatorQuotaSync,
	type CourtListenerCoordinatorQuotaSyncCompletion,
	type CourtListenerCoordinatorQuotaSyncRateLimited,
	type CourtListenerCoordinatorRpc,
	admitSchema,
	completeSyncSchema,
	outcomeInputSchema,
	rateLimitedSyncSchema,
	stateSchema,
	syncSchema,
} from "../courtlistener/coordinator-contract.js";
import type { PgDatabase, PgTransaction } from "./database.js";

type BudgetRow = {
	state: unknown;
	enabled: boolean;
	max_minute: number;
	max_hour: number;
	max_day: number;
	daily_reserve: number;
};

export class PostgresCourtListenerCoordinator implements CourtListenerCoordinatorRpc {
	constructor(
		private readonly database: PgDatabase,
		private readonly credentialId: string,
	) {}

	async admit(input: CourtListenerCoordinatorAdmission): Promise<BudgetDecision> {
		return this.transition(async (transaction, row, state, now) => {
			const parsed = admitSchema.parse({ ...input, now });
			if (await this.usedToken(transaction, parsed.reservationToken))
				return { kind: "reservation_conflict", state };
			const cap = await this.ownerLimit(transaction, row, now);
			if (cap !== null) return { kind: "quota_exhausted", retryAt: cap, state };
			const result = admitCourtListenerRequest({ ...parsed, state });
			if (result.kind === "reserved")
				await this.recordAttempt(transaction, parsed.reservationToken, parsed.endpoint, now);
			return result;
		});
	}

	async beginQuotaSync(input: CourtListenerCoordinatorQuotaSync): Promise<QuotaSyncStart> {
		return this.transition(async (transaction, _row, state, now) => {
			const parsed = syncSchema.parse({ ...input, now });
			if (await this.usedToken(transaction, parsed.syncToken))
				return { kind: "already_in_progress", state };
			const result = beginQuotaSync({ ...parsed, state });
			if (result.kind === "started")
				await this.recordAttempt(transaction, parsed.syncToken, "quota_sync", now);
			return result;
		});
	}

	async recordQuotaSync(input: CourtListenerCoordinatorQuotaSyncCompletion) {
		return this.transition(async (transaction, row, state, now) => {
			const parsed = completeSyncSchema.parse({ ...input, now });
			const windows = parsed.windows.map((window) => ({
				...window,
				remaining:
					window.windowSeconds >= 86_400
						? Math.max(0, window.remaining - row.daily_reserve)
						: window.remaining,
			}));
			const result = recordQuotaSync({ ...parsed, windows, state });
			if (result.kind === "recorded")
				await this.completeAttempt(transaction, parsed.syncToken, now);
			return result;
		});
	}

	async failQuotaSync(input: CourtListenerCoordinatorQuotaSync) {
		return this.transition(async (transaction, _row, state, now) => {
			const parsed = syncSchema.parse({ ...input, now });
			const result = failQuotaSync({ ...parsed, state });
			if (result.kind === "recorded")
				await this.completeAttempt(transaction, parsed.syncToken, now);
			return result;
		});
	}

	async recordQuotaSyncRateLimited(input: CourtListenerCoordinatorQuotaSyncRateLimited) {
		return this.transition(async (transaction, _row, state, now) => {
			const parsed = rateLimitedSyncSchema.parse({ ...input, now });
			const result = recordQuotaSyncRateLimited({ ...parsed, state });
			if (result.kind === "recorded")
				await this.completeAttempt(transaction, parsed.syncToken, now);
			return result;
		});
	}

	async recordOutcome(input: CourtListenerCoordinatorOutcome) {
		return this.transition(async (transaction, _row, state, now) => {
			const parsed = outcomeInputSchema.parse({ ...input, now });
			const result = recordCourtListenerOutcome({ ...parsed, state });
			if (result.kind === "recorded")
				await this.completeAttempt(transaction, parsed.reservationToken, now);
			return result;
		});
	}

	private async transition<T extends { readonly state: CourtListenerBudgetState }>(
		operation: (
			transaction: PgTransaction,
			row: BudgetRow,
			state: CourtListenerBudgetState,
			now: Date,
		) => Promise<T>,
	): Promise<T> {
		return this.database.transaction(async (transaction) => {
			const result = await transaction.query<BudgetRow>(
				"SELECT state, enabled, max_minute, max_hour, max_day, daily_reserve FROM lexcerta.upstream_budgets WHERE credential_id = $1 FOR UPDATE",
				[this.credentialId],
			);
			const row = result.rows[0];
			if (row === undefined || !row.enabled) throw new Error("upstream budget unavailable");
			const state = stateSchema.parse(row.state);
			const now = await transaction.now();
			const next = await operation(transaction, row, state, now);
			stateSchema.parse(next.state);
			await transaction.query(
				"UPDATE lexcerta.upstream_budgets SET state = $2 WHERE credential_id = $1",
				[this.credentialId, JSON.stringify(next.state)],
			);
			return next;
		});
	}

	private async usedToken(transaction: PgTransaction, token: string): Promise<boolean> {
		return (
			(
				await transaction.query(
					"SELECT 1 FROM lexcerta.upstream_attempts WHERE credential_id = $1 AND token = $2",
					[this.credentialId, token],
				)
			).rowCount !== 0
		);
	}
	private async recordAttempt(transaction: PgTransaction, token: string, kind: string, now: Date) {
		await transaction.query(
			"INSERT INTO lexcerta.upstream_attempts(credential_id, token, kind, reserved_at) VALUES ($1,$2,$3,$4)",
			[this.credentialId, token, kind, now],
		);
	}
	private async completeAttempt(transaction: PgTransaction, token: string, now: Date) {
		await transaction.query(
			"UPDATE lexcerta.upstream_attempts SET completed_at = $3 WHERE credential_id = $1 AND token = $2 AND completed_at IS NULL",
			[this.credentialId, token, now],
		);
	}
	private async ownerLimit(
		transaction: PgTransaction,
		row: BudgetRow,
		now: Date,
	): Promise<Date | null> {
		const attempts = await transaction.query<{ reserved_at: Date }>(
			"SELECT reserved_at FROM lexcerta.upstream_attempts WHERE credential_id = $1 AND kind <> 'quota_sync' AND reserved_at > $2 ORDER BY reserved_at",
			[this.credentialId, new Date(now.getTime() - 86_400_000)],
		);
		const blocked = [];
		for (const [duration, limit] of [
			[60_000, row.max_minute],
			[3_600_000, row.max_hour],
			[86_400_000, row.max_day],
		] as const) {
			const inWindow = attempts.rows.filter(
				(attempt) => attempt.reserved_at.getTime() > now.getTime() - duration,
			);
			const blocking = inWindow[inWindow.length - limit];
			if (blocking !== undefined) blocked.push(blocking.reserved_at.getTime() + duration);
		}
		return blocked.length === 0 ? null : new Date(Math.max(...blocked));
	}
}

// Explicit operator/setup action. Public request handling never creates missing authority.
export async function initializeUpstreamBudget(
	database: PgDatabase,
	credentialId: string,
): Promise<void> {
	await database.transaction(async (transaction) => {
		await transaction.query(
			"INSERT INTO lexcerta.upstream_budgets(credential_id, state) VALUES ($1,$2) ON CONFLICT (credential_id) DO NOTHING",
			[credentialId, JSON.stringify(initialCourtListenerBudgetState())],
		);
	});
}

import {
	CourtListenerCoordinatorStateError,
	admitSchema,
	completeSyncSchema,
	outcomeInputSchema,
	rateLimitedSyncSchema,
	stateSchema,
	syncSchema,
} from "./coordinator-contract.js";
import type {
	CourtListenerCoordinatorAdmission,
	CourtListenerCoordinatorOutcome,
	CourtListenerCoordinatorQuotaSync,
	CourtListenerCoordinatorQuotaSyncCompletion,
	CourtListenerCoordinatorQuotaSyncRateLimited,
	CourtListenerCoordinatorRpc,
} from "./coordinator-contract.js";
export type {
	CourtListenerCoordinatorAdmission,
	CourtListenerCoordinatorQuotaSync,
	CourtListenerCoordinatorQuotaSyncCompletion,
	CourtListenerCoordinatorQuotaSyncRateLimited,
	CourtListenerCoordinatorOutcome,
	CourtListenerCoordinatorRpc,
} from "./coordinator-contract.js";
export { CourtListenerCoordinatorStateError } from "./coordinator-contract.js";
import { DurableObject } from "cloudflare:workers";
import {
	type BudgetDecision,
	type CourtListenerBudgetState,
	type OutcomeRecord,
	type QuotaSyncCompletion,
	type QuotaSyncStart,
	admitCourtListenerRequest,
	beginQuotaSync,
	failQuotaSync,
	initialCourtListenerBudgetState,
	recordCourtListenerOutcome,
	recordQuotaSync,
	recordQuotaSyncRateLimited,
} from "./budget.js";

export class CourtListenerCoordinator extends DurableObject implements CourtListenerCoordinatorRpc {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.ctx.blockConcurrencyWhile(async () => {
			this.ctx.storage.sql.exec(
				"CREATE TABLE IF NOT EXISTS courtlistener_budget_state (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), state_json TEXT NOT NULL)",
			);
			this.ctx.storage.sql.exec(
				"INSERT INTO courtlistener_budget_state (singleton, state_json) VALUES (1, ?1) ON CONFLICT(singleton) DO NOTHING",
				JSON.stringify(initialCourtListenerBudgetState()),
			);
		});
	}

	async admit(input: CourtListenerCoordinatorAdmission): Promise<BudgetDecision> {
		const parsed = admitSchema.parse(input);
		return this.transition((state) => admitCourtListenerRequest({ ...parsed, state }));
	}

	async beginQuotaSync(input: CourtListenerCoordinatorQuotaSync): Promise<QuotaSyncStart> {
		const parsed = syncSchema.parse(input);
		return this.transition((state) => beginQuotaSync({ ...parsed, state }));
	}

	async recordQuotaSync(
		input: CourtListenerCoordinatorQuotaSyncCompletion,
	): Promise<QuotaSyncCompletion> {
		const parsed = completeSyncSchema.parse(input);
		return this.transition((state) => recordQuotaSync({ ...parsed, state }));
	}

	async failQuotaSync(input: CourtListenerCoordinatorQuotaSync): Promise<QuotaSyncCompletion> {
		const parsed = syncSchema.parse(input);
		return this.transition((state) => failQuotaSync({ ...parsed, state }));
	}

	async recordQuotaSyncRateLimited(
		input: CourtListenerCoordinatorQuotaSyncRateLimited,
	): Promise<QuotaSyncCompletion> {
		const parsed = rateLimitedSyncSchema.parse(input);
		return this.transition((state) => recordQuotaSyncRateLimited({ ...parsed, state }));
	}

	async recordOutcome(input: CourtListenerCoordinatorOutcome): Promise<OutcomeRecord> {
		const parsed = outcomeInputSchema.parse(input);
		return this.transition((state) => recordCourtListenerOutcome({ ...parsed, state }));
	}

	private transition<Result extends { readonly state: CourtListenerBudgetState }>(
		operation: (state: CourtListenerBudgetState) => Result,
	): Result {
		return this.ctx.storage.transactionSync(() => {
			const result = operation(this.readState());
			this.ctx.storage.sql.exec(
				"UPDATE courtlistener_budget_state SET state_json = ?1 WHERE singleton = 1",
				JSON.stringify(result.state),
			);
			return result;
		});
	}

	private readState(): CourtListenerBudgetState {
		const row = this.ctx.storage.sql
			.exec<{ readonly state_json: string }>(
				"SELECT state_json FROM courtlistener_budget_state WHERE singleton = 1",
			)
			.toArray()[0];
		if (row === undefined)
			throw new CourtListenerCoordinatorStateError("CourtListener coordinator state is missing");
		let raw: unknown;
		try {
			raw = JSON.parse(row.state_json);
		} catch (error) {
			throw new CourtListenerCoordinatorStateError("CourtListener coordinator state is malformed", {
				cause: error,
			});
		}
		const parsed = stateSchema.safeParse(raw);
		if (!parsed.success)
			throw new CourtListenerCoordinatorStateError("CourtListener coordinator state is malformed", {
				cause: parsed.error,
			});
		return parsed.data;
	}
}

import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import {
	type BudgetDecision,
	type CourtListenerBudgetState,
	type CourtListenerDataEndpoint,
	type CourtListenerOutcome,
	type OutcomeRecord,
	type QuotaSyncCompletion,
	type QuotaSyncStart,
	type QuotaWindow,
	admitCourtListenerRequest,
	beginQuotaSync,
	failQuotaSync,
	initialCourtListenerBudgetState,
	recordCourtListenerOutcome,
	recordQuotaSync,
	recordQuotaSyncRateLimited,
} from "./budget.js";

const dateSchema = z
	.union([z.date(), z.string().datetime({ offset: true }), z.number().int().nonnegative()])
	.transform((value) => (value instanceof Date ? value : new Date(value)));
const endpointSchema = z.enum(["citation", "case_law"]);
const tokenSchema = z.string().min(1).max(128);
const windowSchema = z
	.object({
		limit: z.number().int().positive().safe(),
		rate: z.string().min(1).max(64),
		remaining: z.number().int().nonnegative(),
		resetAt: dateSchema.nullable(),
		scope: z.string().min(1).max(64),
		windowSeconds: z.number().int().positive().safe(),
	})
	.strict();
const outcomeSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("success") }).strict(),
	z.object({ kind: z.literal("timeout") }).strict(),
	z.object({ kind: z.literal("server_error") }).strict(),
	z.object({ kind: z.literal("transport_error") }).strict(),
	z.object({ kind: z.literal("malformed_response") }).strict(),
	z.object({ kind: z.literal("rate_limited"), retryAt: dateSchema }).strict(),
]);
const circuitSchema = z.discriminatedUnion("kind", [
	z
		.object({
			consecutiveFailures: z.union([z.literal(0), z.literal(1), z.literal(2)]),
			kind: z.literal("closed"),
		})
		.strict(),
	z
		.object({
			kind: z.literal("open"),
			openForMilliseconds: z.number().int().positive(),
			retryAt: dateSchema,
		})
		.strict(),
	z
		.object({ kind: z.literal("half_open"), openForMilliseconds: z.number().int().positive() })
		.strict(),
]);
const confirmedQuotaSchema = z
	.object({ confirmedAt: dateSchema, windows: z.array(windowSchema).max(100) })
	.strict();
const rateLimitSchema = z
	.object({
		immediateSyncRequired: z.boolean(),
		prior: confirmedQuotaSchema.nullable(),
		retryAt: dateSchema,
	})
	.strict();
const quotaSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("unknown") }).strict(),
	z.object({ kind: z.literal("confirmed"), value: confirmedQuotaSchema }).strict(),
	z
		.object({
			capturedDataReservationEndpoints: z.array(endpointSchema).max(100),
			kind: z.literal("sync_in_progress"),
			leaseExpiresAt: dateSchema,
			prior: confirmedQuotaSchema.nullable(),
			rateLimit: rateLimitSchema.nullable(),
			token: tokenSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("sync_backoff"),
			prior: confirmedQuotaSchema.nullable(),
			retryAt: dateSchema,
		})
		.strict(),
	z.object({ kind: z.literal("rate_limited"), ...rateLimitSchema.shape }).strict(),
]);
const stateSchema = z
	.object({
		circuits: z.object({ case_law: circuitSchema, citation: circuitSchema }).strict(),
		pendingReservations: z
			.array(
				z.discriminatedUnion("kind", [
					z
						.object({
							endpoint: endpointSchema,
							kind: z.literal("data"),
							leaseExpiresAt: dateSchema,
							token: tokenSchema,
						})
						.strict(),
					z
						.object({
							kind: z.literal("quota_sync"),
							leaseExpiresAt: dateSchema,
							token: tokenSchema,
						})
						.strict(),
				]),
			)
			.max(100),
		quota: quotaSchema,
	})
	.strict();
const admitSchema = z
	.object({ endpoint: endpointSchema, now: dateSchema, reservationToken: tokenSchema })
	.strict();
const syncSchema = z.object({ now: dateSchema, syncToken: tokenSchema }).strict();
const completeSyncSchema = syncSchema
	.extend({ windows: z.array(windowSchema).min(1).max(100) })
	.strict();
const rateLimitedSyncSchema = syncSchema.extend({ retryAt: dateSchema }).strict();
const outcomeInputSchema = z
	.object({
		endpoint: endpointSchema,
		now: dateSchema,
		outcome: outcomeSchema,
		reservationToken: tokenSchema,
	})
	.strict();

export type CourtListenerCoordinatorAdmission = {
	readonly endpoint: CourtListenerDataEndpoint;
	readonly now: Date;
	readonly reservationToken: string;
};
export type CourtListenerCoordinatorQuotaSync = { readonly now: Date; readonly syncToken: string };
export type CourtListenerCoordinatorQuotaSyncCompletion = CourtListenerCoordinatorQuotaSync & {
	readonly windows: readonly QuotaWindow[];
};
export type CourtListenerCoordinatorQuotaSyncRateLimited = CourtListenerCoordinatorQuotaSync & {
	readonly retryAt: Date;
};
export type CourtListenerCoordinatorOutcome = {
	readonly endpoint: CourtListenerDataEndpoint;
	readonly now: Date;
	readonly outcome: CourtListenerOutcome;
	readonly reservationToken: string;
};

export interface CourtListenerCoordinatorRpc {
	admit(input: CourtListenerCoordinatorAdmission): Promise<BudgetDecision>;
	beginQuotaSync(input: CourtListenerCoordinatorQuotaSync): Promise<QuotaSyncStart>;
	recordQuotaSync(input: CourtListenerCoordinatorQuotaSyncCompletion): Promise<QuotaSyncCompletion>;
	failQuotaSync(input: CourtListenerCoordinatorQuotaSync): Promise<QuotaSyncCompletion>;
	recordQuotaSyncRateLimited(
		input: CourtListenerCoordinatorQuotaSyncRateLimited,
	): Promise<QuotaSyncCompletion>;
	recordOutcome(input: CourtListenerCoordinatorOutcome): Promise<OutcomeRecord>;
}

export class CourtListenerCoordinatorStateError extends Error {
	readonly name = "CourtListenerCoordinatorStateError";
}

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

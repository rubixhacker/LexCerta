import { z } from "zod";
import type {
	BudgetDecision,
	CourtListenerDataEndpoint,
	CourtListenerOutcome,
	OutcomeRecord,
	QuotaSyncCompletion,
	QuotaSyncStart,
	QuotaWindow,
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
export const stateSchema = z
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
export const admitSchema = z
	.object({ endpoint: endpointSchema, now: dateSchema, reservationToken: tokenSchema })
	.strict();
export const syncSchema = z.object({ now: dateSchema, syncToken: tokenSchema }).strict();
export const completeSyncSchema = syncSchema
	.extend({ windows: z.array(windowSchema).min(1).max(100) })
	.strict();
export const rateLimitedSyncSchema = syncSchema.extend({ retryAt: dateSchema }).strict();
export const outcomeInputSchema = z
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

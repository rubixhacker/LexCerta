export const COURTLISTENER_LEASE_MILLISECONDS = 10_000;
export const FIRST_OPEN_MILLISECONDS = 30_000;
export const MAX_PENDING_RESERVATIONS = 100;
export const QUOTA_SYNC_INTERVAL_MILLISECONDS = 15 * 60_000;

export type CourtListenerDataEndpoint = "citation" | "case_law";
export type CourtListenerEndpoint = CourtListenerDataEndpoint | "quota_sync";

export type QuotaWindow = {
	readonly limit: number;
	readonly rate: string;
	readonly remaining: number;
	readonly resetAt: Date | null;
	readonly scope: string;
	readonly windowSeconds: number;
};

export type ConfirmedQuota = {
	readonly confirmedAt: Date;
	readonly windows: readonly QuotaWindow[];
};

export type CircuitState =
	| { readonly consecutiveFailures: 0 | 1 | 2; readonly kind: "closed" }
	| { readonly kind: "open"; readonly openForMilliseconds: number; readonly retryAt: Date }
	| { readonly kind: "half_open"; readonly openForMilliseconds: number };

export type RateLimitState = {
	readonly immediateSyncRequired: boolean;
	readonly prior: ConfirmedQuota | null;
	readonly retryAt: Date;
};

export type QuotaState =
	| { readonly kind: "unknown" }
	| { readonly kind: "confirmed"; readonly value: ConfirmedQuota }
	| {
			readonly kind: "sync_in_progress";
			readonly leaseExpiresAt: Date;
			readonly prior: ConfirmedQuota | null;
			readonly rateLimit: RateLimitState | null;
			readonly token: string;
	  }
	| { readonly kind: "sync_backoff"; readonly prior: ConfirmedQuota | null; readonly retryAt: Date }
	| ({ readonly kind: "rate_limited" } & RateLimitState);

export type Reservation =
	| {
			readonly endpoint: CourtListenerDataEndpoint;
			readonly kind: "data";
			readonly leaseExpiresAt: Date;
			readonly token: string;
	  }
	| { readonly kind: "quota_sync"; readonly leaseExpiresAt: Date; readonly token: string };

export type CourtListenerBudgetState = {
	readonly circuits: Readonly<Record<CourtListenerDataEndpoint, CircuitState>>;
	readonly pendingReservations: readonly Reservation[];
	readonly quota: QuotaState;
};

export function initialCourtListenerBudgetState(): CourtListenerBudgetState {
	return {
		circuits: {
			case_law: { consecutiveFailures: 0, kind: "closed" },
			citation: { consecutiveFailures: 0, kind: "closed" },
		},
		pendingReservations: [],
		quota: { kind: "unknown" },
	};
}

export function after(now: Date, milliseconds: number): Date {
	return new Date(now.getTime() + milliseconds);
}

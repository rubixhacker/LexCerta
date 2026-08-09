import type { CourtListenerBudgetState, CourtListenerDataEndpoint } from "./budget-state.js";

export type BudgetDecision =
	| { readonly kind: "sync_required"; readonly state: CourtListenerBudgetState }
	| { readonly kind: "sync_in_progress"; readonly state: CourtListenerBudgetState }
	| {
			readonly kind: "sync_unavailable";
			readonly retryAt: Date;
			readonly state: CourtListenerBudgetState;
	  }
	| {
			readonly kind: "quota_limited";
			readonly retryAt: Date;
			readonly state: CourtListenerBudgetState;
	  }
	| {
			readonly kind: "quota_exhausted";
			readonly retryAt: Date | null;
			readonly state: CourtListenerBudgetState;
	  }
	| {
			readonly kind: "circuit_open";
			readonly retryAt: Date;
			readonly state: CourtListenerBudgetState;
	  }
	| { readonly kind: "probe_in_flight"; readonly state: CourtListenerBudgetState }
	| { readonly kind: "reservation_conflict"; readonly state: CourtListenerBudgetState }
	| { readonly kind: "reservation_capacity_exhausted"; readonly state: CourtListenerBudgetState }
	| {
			readonly kind: "reserved";
			readonly state: CourtListenerBudgetState;
			readonly token: string;
	  };

export type QuotaSyncStart =
	| { readonly kind: "started"; readonly state: CourtListenerBudgetState }
	| { readonly kind: "already_in_progress"; readonly state: CourtListenerBudgetState }
	| { readonly kind: "reservation_capacity_exhausted"; readonly state: CourtListenerBudgetState }
	| {
			readonly kind: "quota_sync_quota_exhausted";
			readonly retryAt: Date | null;
			readonly state: CourtListenerBudgetState;
	  }
	| {
			readonly kind: "not_due";
			readonly retryAt: Date;
			readonly state: CourtListenerBudgetState;
	  };

export type QuotaSyncCompletion =
	| { readonly kind: "recorded"; readonly state: CourtListenerBudgetState }
	| { readonly kind: "unknown_sync_token"; readonly state: CourtListenerBudgetState };

export type CourtListenerOutcome =
	| { readonly kind: "success" }
	| { readonly kind: "timeout" }
	| { readonly kind: "server_error" }
	| { readonly kind: "transport_error" }
	| { readonly kind: "malformed_response" }
	| { readonly kind: "rate_limited"; readonly retryAt: Date };

export type OutcomeRecord =
	| { readonly kind: "recorded"; readonly state: CourtListenerBudgetState }
	| { readonly kind: "unknown_reservation"; readonly state: CourtListenerBudgetState };

export type AdmissionInput = {
	readonly endpoint: CourtListenerDataEndpoint;
	readonly now: Date;
	readonly reservationToken: string;
	readonly state: CourtListenerBudgetState;
};

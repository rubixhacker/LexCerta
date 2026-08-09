import type {
	OpinionSourceCacheState,
	OpinionSourceProvenance,
	OpinionSourceRepresentation,
} from "../verification/opinion-source-cache.js";

export const OPINION_SOURCE_FETCH_LEASE_MS = 10_000;

export type OpinionSourceWriteObservation =
	| {
			readonly kind: "positive";
			readonly provenance: OpinionSourceProvenance;
			readonly representation: OpinionSourceRepresentation;
			readonly sourceText: string;
	  }
	| { readonly kind: "negative"; readonly provenance: OpinionSourceProvenance };

export type OpinionSourceReadResult =
	| {
			readonly kind: "positive";
			readonly state: Extract<OpinionSourceCacheState, { readonly kind: "positive" }>;
			readonly sourceText: string;
	  }
	| {
			readonly kind: "state";
			readonly state: Exclude<OpinionSourceCacheState, { readonly kind: "empty" | "positive" }>;
	  };

export type OpinionSourceLeaseAcquireResult =
	| { readonly kind: "acquired"; readonly expiresAt: string }
	| { readonly kind: "held"; readonly expiresAt: string };

export type OpinionSourceLeaseFillResult =
	| {
			readonly kind: "stored";
			readonly state: Exclude<OpinionSourceCacheState, { readonly kind: "empty" }>;
	  }
	| { readonly kind: "lease_unavailable" };

export type OpinionSourceLeaseReleaseResult =
	| { readonly kind: "released" }
	| { readonly kind: "lease_unavailable" };

export type OpinionSourceLeasePurgeResult =
	| {
			readonly kind: "purged";
			readonly state: Exclude<OpinionSourceCacheState, { readonly kind: "empty" }> | null;
	  }
	| { readonly kind: "state_changed" }
	| { readonly kind: "lease_unavailable" };

export type OpinionSourceStore = {
	readonly read: (input: {
		readonly provenance: OpinionSourceProvenance;
	}) => Promise<OpinionSourceReadResult | null>;
	readonly acquireLease: (input: {
		readonly now: Date;
		readonly opinionId: number;
		readonly ownerToken: string;
	}) => Promise<OpinionSourceLeaseAcquireResult>;
	readonly fillLease: (input: {
		readonly now: Date;
		readonly ownerToken: string;
		readonly observation: OpinionSourceWriteObservation;
	}) => Promise<OpinionSourceLeaseFillResult>;
	readonly purgeExpiredNegativeLease: (input: {
		readonly expected: Extract<OpinionSourceCacheState, { readonly kind: "negative" }>;
		readonly now: Date;
		readonly opinionId: number;
		readonly ownerToken: string;
	}) => Promise<OpinionSourceLeasePurgeResult>;
	readonly releaseLease: (input: {
		readonly now: Date;
		readonly opinionId: number;
		readonly ownerToken: string;
	}) => Promise<OpinionSourceLeaseReleaseResult>;
};

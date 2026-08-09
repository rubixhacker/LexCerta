import type { OpinionTextRepresentation } from "../verification/quote-contract.js";

export const OPINION_FETCH_LEASE_MS = 10_000;

export type CachedOpinion = {
	readonly opinionId: number;
	readonly clusterId: number;
	readonly canonicalUrl: string;
	readonly representation: OpinionTextRepresentation;
	readonly retrievedAt: Date;
	readonly freshUntil: Date;
	readonly sourceText: string;
};

export type OpinionLeaseAcquireResult =
	| { readonly kind: "acquired"; readonly expiresAt: string }
	| { readonly kind: "held"; readonly expiresAt: string };

export type OpinionLeaseFillResult =
	| { readonly kind: "stored"; readonly opinion: CachedOpinion }
	| { readonly kind: "lease_unavailable" };

export type OpinionLeaseReleaseResult =
	| { readonly kind: "released" }
	| { readonly kind: "lease_unavailable" };

export type OpinionCacheStore = {
	readonly read: (input: { readonly opinionId: number }) => Promise<CachedOpinion | null>;
	readonly acquireLease: (input: {
		readonly opinionId: number;
		readonly ownerToken: string;
		readonly now: Date;
	}) => Promise<OpinionLeaseAcquireResult>;
	readonly fillLease: (input: {
		readonly ownerToken: string;
		readonly now: Date;
		readonly opinion: CachedOpinion;
	}) => Promise<OpinionLeaseFillResult>;
	readonly releaseLease: (input: {
		readonly opinionId: number;
		readonly ownerToken: string;
	}) => Promise<OpinionLeaseReleaseResult>;
};

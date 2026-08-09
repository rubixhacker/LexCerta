import type {
	CitationSourceCacheState,
	CitationSourceObservation,
} from "../verification/citation-source-cache.js";

export const CITATION_FETCH_LEASE_MS = 10_000;

export type StoredCitationObservation = Exclude<
	CitationSourceCacheState,
	{ readonly kind: "empty" }
>;

export type LeaseAcquireResult =
	| { readonly kind: "acquired"; readonly expiresAt: string }
	| { readonly kind: "held"; readonly expiresAt: string };

export type LeaseFillResult =
	| { readonly kind: "stored"; readonly observation: StoredCitationObservation }
	| { readonly kind: "lease_unavailable" };

export type LeaseReleaseResult =
	| { readonly kind: "released" }
	| { readonly kind: "lease_unavailable" };

export type CitationObservationStore = {
	readonly read: (input: {
		readonly normalizedCitation: string;
	}) => Promise<StoredCitationObservation | null>;
	readonly acquireLease: (input: {
		readonly normalizedCitation: string;
		readonly ownerToken: string;
		readonly now: Date;
	}) => Promise<LeaseAcquireResult>;
	readonly fillLease: (input: {
		readonly normalizedCitation: string;
		readonly ownerToken: string;
		readonly now: Date;
		readonly observation: CitationSourceObservation;
	}) => Promise<LeaseFillResult>;
	readonly releaseLease: (input: {
		readonly normalizedCitation: string;
		readonly ownerToken: string;
	}) => Promise<LeaseReleaseResult>;
};

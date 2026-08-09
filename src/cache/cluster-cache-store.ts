export const CLUSTER_FETCH_LEASE_MS = 10_000;
export const DEFAULT_CLUSTER_FRESHNESS_MS = 30 * 24 * 60 * 60 * 1_000;
export const MAX_OPINIONS_PER_CLUSTER = 100;

export type CachedCluster = {
	readonly clusterId: number;
	readonly canonicalUrl: string;
	readonly opinions: readonly { readonly id: number; readonly url: string }[];
	readonly retrievedAt: Date;
	readonly freshUntil: Date;
};

export type ClusterLeaseResult =
	| { readonly kind: "acquired"; readonly expiresAt: string }
	| { readonly kind: "held"; readonly expiresAt: string };

export type ClusterCacheStore = {
	readonly readCluster: (input: { readonly clusterId: number }) => Promise<CachedCluster | null>;
	readonly acquireClusterLease: (input: {
		readonly clusterId: number;
		readonly ownerToken: string;
		readonly now: Date;
	}) => Promise<ClusterLeaseResult>;
	readonly fillClusterLease: (input: {
		readonly ownerToken: string;
		readonly now: Date;
		readonly cluster: Omit<CachedCluster, "retrievedAt" | "freshUntil">;
	}) => Promise<
		| { readonly kind: "stored"; readonly cluster: CachedCluster }
		| { readonly kind: "lease_unavailable" }
	>;
	readonly releaseClusterLease: (input: {
		readonly clusterId: number;
		readonly ownerToken: string;
	}) => Promise<{ readonly kind: "released" } | { readonly kind: "lease_unavailable" }>;
};

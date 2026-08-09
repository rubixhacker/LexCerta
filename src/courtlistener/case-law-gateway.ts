import type { CachedCluster, ClusterCacheStore } from "../cache/cluster-cache-store.js";
import type { OpinionCacheStore } from "../cache/opinion-cache-store.js";
import type { QuoteVerificationGateway } from "../verification/verify-quote.js";
import type { CourtListenerApi } from "./api.js";
import { requestCaseLaw } from "./case-law-admission.js";
import type { CourtListenerCaseLawApi } from "./case-law-api.js";
import { readCaseLawOpinion } from "./case-law-opinion-cache.js";
import type { CourtListenerCoordinatorRpc } from "./coordinator.js";

type QuoteFailureReason =
	| "incomplete"
	| "timeout"
	| "upstream_unavailable"
	| "quota_unknown"
	| "rate_limited"
	| "circuit_open";

export type CourtListenerCaseLawGatewayOptions = {
	readonly api: CourtListenerCaseLawApi;
	readonly clusters: ClusterCacheStore;
	readonly coordinator: CourtListenerCoordinatorRpc;
	readonly now: () => Date;
	readonly opinionFreshnessMs?: number;
	readonly opinions: OpinionCacheStore;
	readonly quotaApi: Pick<CourtListenerApi, "getUsage">;
	readonly token: () => string;
	readonly waitForFill?: (delayMilliseconds: number) => Promise<void>;
};

export function createCourtListenerCaseLawGateway(
	options: CourtListenerCaseLawGatewayOptions,
): QuoteVerificationGateway {
	return {
		async readCluster(cluster) {
			const cached = await readCluster(options, cluster);
			if (cached !== undefined && fresh(cached, cluster, options.now()))
				return foundCluster(cached);
			const ownerToken = options.token();
			const lease = await value(() =>
				options.clusters.acquireClusterLease({
					clusterId: cluster.id,
					ownerToken,
					now: options.now(),
				}),
			);
			if (lease === undefined) return indeterminate("upstream_unavailable");
			if (lease.kind === "held") {
				const filled = await waitForCluster(options, cluster, lease.expiresAt);
				return filled === undefined ? indeterminate("upstream_unavailable") : foundCluster(filled);
			}
			const rechecked = await readCluster(options, cluster);
			if (rechecked !== undefined && fresh(rechecked, cluster, options.now())) {
				await releaseCluster(options, cluster.id, ownerToken);
				return foundCluster(rechecked);
			}
			const requested = await requestCaseLaw(options, () => options.api.getCluster(cluster.id));
			if (requested.kind === "indeterminate") {
				await releaseCluster(options, cluster.id, ownerToken);
				return indeterminate(requested.reason, requested.retryAfterSeconds);
			}
			return handleClusterSource(options, cluster, ownerToken, requested.source);
		},
		readOpinion: (input) =>
			readCaseLawOpinion(input, {
				fetch: async (opinionUrl) => {
					const result = await requestCaseLaw(options, () => options.api.getOpinion(opinionUrl));
					return result.kind === "source" ? result.source : result;
				},
				now: options.now,
				...(options.opinionFreshnessMs === undefined
					? {}
					: { opinionFreshnessMs: options.opinionFreshnessMs }),
				opinions: options.opinions,
				token: options.token,
				...(options.waitForFill === undefined ? {} : { waitForFill: options.waitForFill }),
			}),
	};
}

async function handleClusterSource(
	options: CourtListenerCaseLawGatewayOptions,
	cluster: { readonly canonicalUrl: string; readonly id: number },
	ownerToken: string,
	source: Awaited<ReturnType<CourtListenerCaseLawApi["getCluster"]>>,
) {
	switch (source.kind) {
		case "found": {
			const filled = await value(() =>
				options.clusters.fillClusterLease({
					now: options.now(),
					ownerToken,
					cluster: {
						canonicalUrl: source.cluster.canonicalUrl,
						clusterId: source.cluster.id,
						opinions: source.cluster.subOpinions,
					},
				}),
			);
			if (filled?.kind === "stored") return foundCluster(filled.cluster);
			const winner = await readCluster(options, cluster);
			return winner === undefined || !fresh(winner, cluster, options.now())
				? indeterminate("upstream_unavailable")
				: foundCluster(winner);
		}
		case "missing":
		case "malformed_response":
			await releaseCluster(options, cluster.id, ownerToken);
			return indeterminate("incomplete");
		case "rate_limited":
			await releaseCluster(options, cluster.id, ownerToken);
			return indeterminate("rate_limited", source.retryAfterSeconds);
		case "unavailable":
			await releaseCluster(options, cluster.id, ownerToken);
			return indeterminate(source.failure === "timeout" ? "timeout" : "upstream_unavailable");
		default:
			return assertNever(source);
	}
}

async function readCluster(
	options: CourtListenerCaseLawGatewayOptions,
	expected: { readonly canonicalUrl: string; readonly id: number },
): Promise<CachedCluster | undefined> {
	const cluster = await value(() => options.clusters.readCluster({ clusterId: expected.id }));
	return cluster === undefined || cluster === null || !matches(cluster, expected)
		? undefined
		: cluster;
}

function fresh(
	cluster: CachedCluster,
	expected: { readonly canonicalUrl: string; readonly id: number },
	now: Date,
): boolean {
	return matches(cluster, expected) && now.getTime() < cluster.freshUntil.getTime();
}

async function waitForCluster(
	options: CourtListenerCaseLawGatewayOptions,
	expected: { readonly canonicalUrl: string; readonly id: number },
	expiresAt: string,
): Promise<CachedCluster | undefined> {
	const deadline = new Date(expiresAt).getTime();
	let delay = 50;
	while (Number.isFinite(deadline)) {
		const beforeWait = options.now().getTime();
		const remaining = deadline - beforeWait;
		if (remaining <= 0) return undefined;
		await (options.waitForFill ?? waitForFill)(Math.min(delay, remaining));
		const cluster = await readCluster(options, expected);
		if (cluster !== undefined && fresh(cluster, expected, options.now())) return cluster;
		if (options.now().getTime() <= beforeWait) return undefined;
		delay = Math.min(delay * 2, 1_000);
	}
	return undefined;
}

function matches(
	cluster: CachedCluster,
	expected: { readonly canonicalUrl: string; readonly id: number },
): boolean {
	return cluster.clusterId === expected.id && cluster.canonicalUrl === expected.canonicalUrl;
}

function indeterminate(reason: QuoteFailureReason, retryAfterSeconds?: number) {
	return {
		kind: "indeterminate" as const,
		reason,
		...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
	};
}

function foundCluster(cluster: CachedCluster) {
	return {
		kind: "found" as const,
		cluster: {
			canonicalUrl: cluster.canonicalUrl,
			id: cluster.clusterId,
			opinionUrls: cluster.opinions.map((opinion) => opinion.url),
		},
	};
}

async function releaseCluster(
	options: CourtListenerCaseLawGatewayOptions,
	clusterId: number,
	ownerToken: string,
): Promise<void> {
	await value(() => options.clusters.releaseClusterLease({ clusterId, ownerToken }));
}

function value<Value>(call: () => Promise<Value>): Promise<Value | undefined> {
	return call().catch((error: unknown) => {
		if (error instanceof Error) return undefined;
		throw error;
	});
}

function waitForFill(delayMilliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, delayMilliseconds));
}

function assertNever(value: never): never {
	throw new TypeError(`Unexpected CourtListener case-law outcome: ${String(value)}`);
}

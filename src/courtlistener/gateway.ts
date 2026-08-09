import type {
	CitationLookup,
	CitationVerificationGateway,
	CitationVerificationObservation,
} from "../verification/verify-citation.js";
import type { CitationLookupOutcome, CourtListenerApi, CourtListenerUsage } from "./api.js";
import type { BudgetDecision, CourtListenerOutcome, QuotaWindow } from "./budget.js";
import type { CourtListenerCoordinatorRpc } from "./coordinator.js";

export type CourtListenerCitationGatewayOptions = {
	readonly api: CourtListenerApi;
	readonly coordinator: CourtListenerCoordinatorRpc;
	readonly now: () => Date;
	readonly token: () => string;
};

export function createCourtListenerCitationGateway(
	options: CourtListenerCitationGatewayOptions,
): CitationVerificationGateway {
	return {
		async lookup(query) {
			const admission = await value(() =>
				options.coordinator.admit({
					endpoint: "citation",
					now: options.now(),
					reservationToken: options.token(),
				}),
			);
			if (admission === null) return quotaUnknown();
			return admit(admission, query, options, true);
		},
	};
}

async function admit(
	admission: BudgetDecision,
	query: CitationLookup,
	options: CourtListenerCitationGatewayOptions,
	maySynchronize: boolean,
): Promise<CitationVerificationObservation> {
	switch (admission.kind) {
		case "reserved":
			return lookupReserved(admission.token, query, options);
		case "sync_required":
			return maySynchronize ? synchronizeAndAdmit(query, options) : quotaUnknown();
		case "quota_limited":
			return rateLimited(options.now(), admission.retryAt);
		case "circuit_open":
			return circuitOpen(options.now(), admission.retryAt);
		case "sync_in_progress":
		case "sync_unavailable":
		case "quota_exhausted":
		case "probe_in_flight":
		case "reservation_conflict":
			return quotaUnknown();
		default:
			return assertNever(admission);
	}
}

async function synchronizeAndAdmit(
	query: CitationLookup,
	options: CourtListenerCitationGatewayOptions,
): Promise<CitationVerificationObservation> {
	const syncToken = options.token();
	const started = await value(() =>
		options.coordinator.beginQuotaSync({ now: options.now(), syncToken }),
	);
	if (started?.kind !== "started") return quotaUnknown();
	const usage = await value(() => options.api.getUsage());
	if (usage?.kind !== "usage") return failSync(syncToken, options);
	const windows = quotaWindows(usage.currentUsage);
	if (windows === null) return failSync(syncToken, options);
	const completed = await value(() =>
		options.coordinator.recordQuotaSync({ now: options.now(), syncToken, windows }),
	);
	if (completed?.kind !== "recorded") return quotaUnknown();
	const admission = await value(() =>
		options.coordinator.admit({
			endpoint: "citation",
			now: options.now(),
			reservationToken: options.token(),
		}),
	);
	if (admission === null) return quotaUnknown();
	return admit(admission, query, options, false);
}

async function failSync(
	syncToken: string,
	options: CourtListenerCitationGatewayOptions,
): Promise<CitationVerificationObservation> {
	await value(() => options.coordinator.failQuotaSync({ now: options.now(), syncToken }));
	return quotaUnknown();
}

async function lookupReserved(
	reservationToken: string,
	query: CitationLookup,
	options: CourtListenerCitationGatewayOptions,
): Promise<CitationVerificationObservation> {
	const source = await value(() =>
		options.api.lookupCitation({ normalized: query.normalizedCitation }),
	);
	if (source === null)
		return record(reservationToken, { kind: "transport_error" }, unavailable(), options);
	const retrievedAt = options.now().toISOString();
	switch (source.kind) {
		case "matched": {
			const cluster = trustedCluster(source);
			return cluster === null
				? record(reservationToken, { kind: "malformed_response" }, incomplete(), options)
				: record(
						reservationToken,
						{ kind: "success" },
						{ kind: "verified", cluster, retrievedAt },
						options,
					);
		}
		case "absent":
			return record(
				reservationToken,
				{ kind: "success" },
				{ kind: "not_found", retrievedAt },
				options,
			);
		case "ambiguous":
		case "unknown_reporter":
		case "item_cap":
		case "malformed_response":
			return record(reservationToken, { kind: "malformed_response" }, incomplete(), options);
		case "rate_limited": {
			const now = options.now();
			const retryAt = new Date(now.getTime() + (source.retryAfterSeconds ?? 0) * 1_000);
			return record(
				reservationToken,
				{ kind: "rate_limited", retryAt },
				rateLimited(now, retryAt),
				options,
			);
		}
		case "unavailable":
			switch (source.failure) {
				case "timeout":
					return record(reservationToken, { kind: "timeout" }, timeout(), options);
				case "server":
					return record(reservationToken, { kind: "server_error" }, unavailable(), options);
				case "transport":
					return record(reservationToken, { kind: "transport_error" }, unavailable(), options);
				default:
					return assertNever(source.failure);
			}
		default:
			return assertNever(source);
	}
}

async function record(
	reservationToken: string,
	outcome: CourtListenerOutcome,
	observation: CitationVerificationObservation,
	options: CourtListenerCitationGatewayOptions,
): Promise<CitationVerificationObservation> {
	const recorded = await value(() =>
		options.coordinator.recordOutcome({
			endpoint: "citation",
			now: options.now(),
			outcome,
			reservationToken,
		}),
	);
	return recorded?.kind === "recorded" ? observation : quotaUnknown();
}

function quotaWindows(usage: readonly CourtListenerUsage[]): readonly QuotaWindow[] | null {
	const windows = usage.flatMap((row) => {
		if (row.scope !== "user" && row.scope !== "citations") return [];
		const resetAt = row.resetAt === null ? null : new Date(row.resetAt);
		if (resetAt !== null && Number.isNaN(resetAt.getTime())) return [];
		return [
			{
				limit: row.limit,
				rate: row.rate,
				remaining: row.blocked ? 0 : row.remaining,
				resetAt,
				scope: row.scope,
				windowSeconds: row.windowSeconds,
			},
		];
	});
	return windows.some((window) => window.scope === "user") &&
		windows.some((window) => window.scope === "citations")
		? windows
		: null;
}

function trustedCluster(source: Extract<CitationLookupOutcome, { readonly kind: "matched" }>) {
	if (source.clusters.length !== 1) return null;
	const cluster = source.clusters[0];
	if (cluster === undefined || !Number.isSafeInteger(cluster.id) || cluster.id <= 0) return null;
	try {
		const url = new URL(cluster.canonicalUrl);
		return url.protocol === "https:" &&
			(url.hostname === "courtlistener.com" || url.hostname === "www.courtlistener.com")
			? cluster
			: null;
	} catch (error) {
		if (error instanceof TypeError) return null;
		throw error;
	}
}

function quotaUnknown(): CitationVerificationObservation {
	return { kind: "indeterminate", reason: "quota_unknown" };
}
function incomplete(): CitationVerificationObservation {
	return { kind: "indeterminate", reason: "incomplete" };
}
function timeout(): CitationVerificationObservation {
	return { kind: "indeterminate", reason: "timeout" };
}
function unavailable(): CitationVerificationObservation {
	return { kind: "indeterminate", reason: "upstream_unavailable" };
}
function rateLimited(now: Date, retryAt: Date): CitationVerificationObservation {
	return {
		kind: "indeterminate",
		reason: "rate_limited",
		retryAfterSeconds: retrySeconds(now, retryAt),
	};
}
function circuitOpen(now: Date, retryAt: Date): CitationVerificationObservation {
	return {
		kind: "indeterminate",
		reason: "circuit_open",
		retryAfterSeconds: retrySeconds(now, retryAt),
	};
}
function retrySeconds(now: Date, retryAt: Date): number {
	return Math.max(1, Math.ceil((retryAt.getTime() - now.getTime()) / 1_000));
}
async function value<Value>(call: () => Promise<Value>): Promise<Value | null> {
	try {
		return await call();
	} catch (error) {
		if (error instanceof Error) return null;
		throw error;
	}
}
function assertNever(value: never): never {
	throw new TypeError(`Unexpected CourtListener outcome: ${String(value)}`);
}

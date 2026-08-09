import { z } from "zod";
import { boundedJsonBody } from "./response-body.js";

const COURTLISTENER_ORIGIN = "https://www.courtlistener.com";
const API_ROOT = `${COURTLISTENER_ORIGIN}/api/rest/v4/`;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_RETRY_AFTER_SECONDS = 604_800;

const citationItemSchema = z
	.object({
		status: z.number().int(),
		normalized_citations: z.array(z.string().min(1).max(256)).max(100),
		clusters: z
			.array(
				z
					.object({
						id: z.number().int().positive().optional(),
						absolute_url: z.string().max(2_048).optional(),
						canonical_url: z.string().max(2_048).optional(),
					})
					.passthrough(),
			)
			.max(100),
	})
	.passthrough();

const usageRowSchema = z
	.object({
		scope: z.string().min(1).max(64),
		rate: z.string().min(1).max(64),
		used: z.number().int().nonnegative(),
		limit: z.number().int().nonnegative(),
		remaining: z.number().int().nonnegative(),
		window_seconds: z.number().int().positive(),
		reset_at: z.string().datetime({ offset: true }).nullable(),
		blocked: z.boolean(),
	})
	.passthrough();

const usageResponseSchema = z
	.object({ current_usage: z.array(usageRowSchema).max(100) })
	.passthrough();

export type CitationLookupInput = { readonly normalized: string };

export type CourtListenerTransport = (request: Request) => Promise<Response>;

export type CourtListenerCluster = { readonly id: number; readonly canonicalUrl: string };

export type CourtListenerFailure = "timeout" | "transport" | "server";

export type CitationLookupOutcome =
	| {
			readonly kind: "matched";
			readonly normalizedCitation: string;
			readonly clusters: readonly CourtListenerCluster[];
	  }
	| { readonly kind: "absent"; readonly normalizedCitation: string }
	| { readonly kind: "ambiguous"; readonly normalizedCitations: readonly string[] }
	| { readonly kind: "unknown_reporter"; readonly normalizedCitation: string }
	| { readonly kind: "item_cap"; readonly normalizedCitation: string }
	| { readonly kind: "rate_limited"; readonly retryAfterSeconds?: number }
	| {
			readonly kind: "unavailable";
			readonly failure: CourtListenerFailure;
			readonly status?: number;
	  }
	| { readonly kind: "malformed_response" };

export type CourtListenerUsage = {
	readonly scope: string;
	readonly rate: string;
	readonly used: number;
	readonly limit: number;
	readonly remaining: number;
	readonly windowSeconds: number;
	readonly resetAt: string | null;
	readonly blocked: boolean;
};

export type ApiUsageOutcome =
	| { readonly kind: "usage"; readonly currentUsage: readonly CourtListenerUsage[] }
	| { readonly kind: "rate_limited"; readonly retryAfterSeconds?: number }
	| { readonly kind: "unavailable" }
	| { readonly kind: "malformed_response" };

export type CourtListenerApi = {
	readonly lookupCitation: (
		input: CitationLookupInput,
		signal?: AbortSignal,
	) => Promise<CitationLookupOutcome>;
	readonly getUsage: (signal?: AbortSignal) => Promise<ApiUsageOutcome>;
};

export type CourtListenerApiOptions = {
	readonly token: string;
	readonly transport: CourtListenerTransport;
	readonly timeoutMs?: number;
	readonly now?: () => Date;
};

function retryAfterSeconds(value: string | null, now: () => Date): number | undefined {
	if (value === null) return undefined;
	const header = z.string().trim().safeParse(value);
	if (!header.success) return undefined;
	if (/^\d+$/.test(header.data)) {
		const seconds = Number(header.data);
		return Number.isSafeInteger(seconds) && seconds <= MAX_RETRY_AFTER_SECONDS
			? seconds
			: undefined;
	}
	const retryAt = Date.parse(header.data);
	if (!Number.isFinite(retryAt)) return undefined;
	const seconds = Math.max(0, Math.ceil((retryAt - now().getTime()) / 1_000));
	return seconds <= MAX_RETRY_AFTER_SECONDS ? seconds : undefined;
}

function canonicalUrl(
	cluster: z.infer<typeof citationItemSchema>["clusters"][number],
): string | undefined {
	const source = cluster.canonical_url ?? cluster.absolute_url;
	if (source === undefined) return undefined;
	try {
		const url = new URL(source, COURTLISTENER_ORIGIN);
		return url.origin === COURTLISTENER_ORIGIN && url.protocol === "https:"
			? url.toString()
			: undefined;
	} catch {
		return undefined;
	}
}

function clusterMetadata(
	clusters: z.infer<typeof citationItemSchema>["clusters"],
): readonly CourtListenerCluster[] {
	return clusters.flatMap((cluster) => {
		const url = canonicalUrl(cluster);
		return cluster.id === undefined || url === undefined
			? []
			: [{ id: cluster.id, canonicalUrl: url }];
	});
}

function rateLimited(
	response: Response,
	now: () => Date,
): {
	readonly kind: "rate_limited";
	readonly retryAfterSeconds?: number;
} {
	const retryAfter = retryAfterSeconds(response.headers.get("retry-after"), now);
	return retryAfter === undefined
		? { kind: "rate_limited" }
		: { kind: "rate_limited", retryAfterSeconds: retryAfter };
}

function signalFor(timeoutMs: number, signal: AbortSignal | undefined): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

async function send(
	transport: CourtListenerTransport,
	request: Request,
): Promise<Response | Exclude<CourtListenerFailure, "server">> {
	try {
		return await transport(request);
	} catch {
		return request.signal.aborted ? "timeout" : "transport";
	}
}

function citationOutcome(
	input: CitationLookupInput,
	response: z.infer<typeof citationItemSchema>[],
): CitationLookupOutcome {
	if (response.length === 0) return { kind: "malformed_response" };
	const item = response[0];
	if (item === undefined || response.length !== 1) return { kind: "malformed_response" };
	switch (item.status) {
		case 200: {
			const clusters = clusterMetadata(item.clusters);
			return clusters.length === 0 || clusters.length !== item.clusters.length
				? { kind: "malformed_response" }
				: { kind: "matched", normalizedCitation: input.normalized, clusters };
		}
		case 300:
			return { kind: "ambiguous", normalizedCitations: item.normalized_citations };
		case 400:
			return { kind: "unknown_reporter", normalizedCitation: input.normalized };
		case 404:
			return { kind: "absent", normalizedCitation: input.normalized };
		case 429:
			return { kind: "item_cap", normalizedCitation: input.normalized };
		default:
			return { kind: "malformed_response" };
	}
}

function usageRow(row: z.infer<typeof usageRowSchema>): CourtListenerUsage {
	return {
		scope: row.scope,
		rate: row.rate,
		used: row.used,
		limit: row.limit,
		remaining: row.remaining,
		windowSeconds: row.window_seconds,
		resetAt: row.reset_at,
		blocked: row.blocked,
	};
}

export function createCourtListenerApi(options: CourtListenerApiOptions): CourtListenerApi {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const now = options.now ?? (() => new Date());
	const authorization = `Token ${options.token}`;
	return {
		async lookupCitation(input, signal) {
			const form = new URLSearchParams({ text: input.normalized });
			const response = await send(
				options.transport,
				new Request(`${API_ROOT}citation-lookup/`, {
					method: "POST",
					headers: {
						accept: "application/json",
						authorization,
						"content-type": "application/x-www-form-urlencoded;charset=UTF-8",
					},
					body: form,
					signal: signalFor(timeoutMs, signal),
				}),
			);
			if (typeof response === "string") return { kind: "unavailable", failure: response };
			if (response.status >= 500 && response.status <= 599) {
				return { kind: "unavailable", failure: "server", status: response.status };
			}
			if (response.status === 429) return rateLimited(response, now);
			if (!response.ok) return { kind: "malformed_response" };
			const parsed = z
				.array(citationItemSchema)
				.max(1)
				.safeParse(await boundedJsonBody(response));
			return parsed.success ? citationOutcome(input, parsed.data) : { kind: "malformed_response" };
		},
		async getUsage(signal) {
			const response = await send(
				options.transport,
				new Request(`${API_ROOT}api-usage/`, {
					method: "GET",
					headers: { accept: "application/json", authorization },
					signal: signalFor(timeoutMs, signal),
				}),
			);
			if (typeof response === "string" || response.status >= 500) return { kind: "unavailable" };
			if (response.status === 429) return rateLimited(response, now);
			if (!response.ok) return { kind: "malformed_response" };
			const parsed = usageResponseSchema.safeParse(await boundedJsonBody(response));
			return parsed.success
				? { kind: "usage", currentUsage: parsed.data.current_usage.map(usageRow) }
				: { kind: "malformed_response" };
		},
	};
}

import { z } from "zod";
import { type CaseLawTransport, retryAfterSeconds, send, signalFor } from "./case-law-request.js";
import { MAX_RESPONSE_BODY_BYTES, boundedJsonBody } from "./response-body.js";

const COURTLISTENER_ORIGIN = "https://www.courtlistener.com";
const API_ROOT = `${COURTLISTENER_ORIGIN}/api/rest/v4/`;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_OPINIONS_PER_CLUSTER = 100;
const MAX_SOURCE_CHARS = 65_536;
const responseBytesSchema = z.number().int().min(1_024).max(MAX_RESPONSE_BODY_BYTES);
const sourceCharactersSchema = z.number().int().min(1).max(MAX_SOURCE_CHARS);
const opinionCountSchema = z.number().int().min(1).max(MAX_OPINIONS_PER_CLUSTER);

const positiveIdSchema = z.number().int().safe().positive();
const sourceTextSchema = z.string().max(MAX_SOURCE_CHARS).nullable().optional();
const clusterSchema = z
	.object({
		absolute_url: z.string().max(2_048).optional(),
		canonical_url: z.string().max(2_048).optional(),
		id: positiveIdSchema,
		sub_opinions: z.array(z.string().max(2_048)).max(MAX_OPINIONS_PER_CLUSTER),
	})
	.passthrough();
const opinionSchema = z
	.object({
		cluster: z.string().max(2_048).optional(),
		cluster_id: positiveIdSchema.optional(),
		html: sourceTextSchema,
		html_with_citations: sourceTextSchema,
		id: positiveIdSchema,
		plain_text: sourceTextSchema,
	})
	.passthrough();

export type CourtListenerCaseLawTransport = CaseLawTransport;

export type CourtListenerSourceText = {
	readonly html?: string;
	readonly htmlWithCitations?: string;
	readonly plainText?: string;
};

export type CourtListenerOpinionReference = { readonly id: number; readonly url: string };

export type CourtListenerCaseLawCluster = {
	readonly canonicalUrl: string;
	readonly id: number;
	readonly subOpinions: readonly CourtListenerOpinionReference[];
};

export type CourtListenerCaseLawOpinion = CourtListenerSourceText & {
	readonly clusterId: number;
	readonly id: number;
};

export type CourtListenerCaseLawFailure = "server" | "timeout" | "transport";

export type CourtListenerCaseLawOutcome<Value extends object> =
	| ({ readonly kind: "found" } & Value)
	| { readonly kind: "missing" }
	| { readonly kind: "malformed_response" }
	| { readonly kind: "rate_limited"; readonly retryAfterSeconds?: number }
	| {
			readonly kind: "unavailable";
			readonly failure: CourtListenerCaseLawFailure;
			readonly status?: number;
	  };

export type CourtListenerCaseLawApi = {
	readonly getCluster: (
		clusterId: number,
		signal?: AbortSignal,
	) => Promise<CourtListenerCaseLawOutcome<{ readonly cluster: CourtListenerCaseLawCluster }>>;
	readonly getOpinion: (
		opinionUrl: string,
		signal?: AbortSignal,
	) => Promise<CourtListenerCaseLawOutcome<{ readonly opinion: CourtListenerCaseLawOpinion }>>;
};

export type CourtListenerCaseLawApiOptions = {
	readonly maxResponseBytes?: number;
	readonly maxSourceCharacters?: number;
	readonly maxOpinionsPerCluster?: number;
	readonly now?: () => Date;
	readonly token: string;
	readonly timeoutMs?: number;
	readonly transport: CourtListenerCaseLawTransport;
};

function trustedPublicUrl(value: string | undefined, id: number): string | undefined {
	if (value === undefined) return undefined;
	try {
		const url = new URL(value, COURTLISTENER_ORIGIN);
		return url.protocol === "https:" &&
			url.hostname === "www.courtlistener.com" &&
			url.search === "" &&
			url.hash === "" &&
			url.pathname.startsWith(`/opinion/${id}/`)
			? url.toString()
			: undefined;
	} catch {
		return undefined;
	}
}

function trustedOpinionReference(value: string): CourtListenerOpinionReference | undefined {
	try {
		const url = new URL(value);
		const match = /^\/api\/rest\/v4\/opinions\/(\d+)\/$/.exec(url.pathname);
		const id = match?.[1] === undefined ? undefined : positiveIdSchema.safeParse(Number(match[1]));
		return url.protocol === "https:" &&
			url.origin === COURTLISTENER_ORIGIN &&
			url.search === "" &&
			url.hash === "" &&
			id?.success
			? { id: id.data, url: url.toString() }
			: undefined;
	} catch {
		return undefined;
	}
}

function trustedClusterId(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	try {
		const url = new URL(value);
		const match = /^\/api\/rest\/v4\/clusters\/(\d+)\/$/.exec(url.pathname);
		const id = match?.[1] === undefined ? undefined : positiveIdSchema.safeParse(Number(match[1]));
		return url.origin === COURTLISTENER_ORIGIN && id?.success ? id.data : undefined;
	} catch {
		return undefined;
	}
}

function usableSource(value: string | null | undefined): string | undefined {
	if (value === undefined || value === null || value.trim() === "") return undefined;
	return value;
}

function clusterFrom(raw: z.infer<typeof clusterSchema>): CourtListenerCaseLawCluster | undefined {
	const canonicalUrl = trustedPublicUrl(raw.canonical_url ?? raw.absolute_url, raw.id);
	const subOpinions = raw.sub_opinions.map(trustedOpinionReference);
	return canonicalUrl === undefined || subOpinions.some((item) => item === undefined)
		? undefined
		: {
				canonicalUrl,
				id: raw.id,
				subOpinions: subOpinions.flatMap((item) => (item === undefined ? [] : [item])),
			};
}

function opinionFrom(raw: z.infer<typeof opinionSchema>): CourtListenerCaseLawOpinion | undefined {
	const linkedClusterId = trustedClusterId(raw.cluster);
	if (
		raw.cluster_id !== undefined &&
		linkedClusterId !== undefined &&
		raw.cluster_id !== linkedClusterId
	)
		return undefined;
	const clusterId = raw.cluster_id ?? linkedClusterId;
	if (clusterId === undefined) return undefined;
	const html = usableSource(raw.html);
	const htmlWithCitations = usableSource(raw.html_with_citations);
	const plainText = usableSource(raw.plain_text);
	return {
		clusterId,
		id: raw.id,
		...(html === undefined ? {} : { html }),
		...(htmlWithCitations === undefined ? {} : { htmlWithCitations }),
		...(plainText === undefined ? {} : { plainText }),
	};
}

function rateLimited(response: Response, now: () => Date): CourtListenerCaseLawOutcome<never> {
	const retryAfter = retryAfterSeconds(response.headers.get("retry-after"), now);
	return retryAfter === undefined
		? { kind: "rate_limited" }
		: { kind: "rate_limited", retryAfterSeconds: retryAfter };
}

export function createCourtListenerCaseLawApi(
	options: CourtListenerCaseLawApiOptions,
): CourtListenerCaseLawApi {
	const authorization = `Token ${options.token}`;
	const now = options.now ?? (() => new Date());
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxResponseBytes = responseBytesSchema.parse(
		options.maxResponseBytes ?? MAX_RESPONSE_BODY_BYTES,
	);
	const maxSourceCharacters = sourceCharactersSchema.parse(
		options.maxSourceCharacters ?? MAX_SOURCE_CHARS,
	);
	const maxOpinionsPerCluster = opinionCountSchema.parse(
		options.maxOpinionsPerCluster ?? MAX_OPINIONS_PER_CLUSTER,
	);
	async function get<Value extends object>(
		url: string,
		signal: AbortSignal | undefined,
		parse: (body: unknown) => Value | undefined,
	): Promise<CourtListenerCaseLawOutcome<Value>> {
		const response = await send(
			options.transport,
			new Request(url, {
				headers: { accept: "application/json", authorization },
				method: "GET",
				signal: signalFor(timeoutMs, signal),
			}),
		);
		if (typeof response === "string") return { kind: "unavailable", failure: response };
		if (response.status === 404) return { kind: "missing" };
		if (response.status === 429) return rateLimited(response, now);
		if (response.status >= 500 && response.status <= 599)
			return { kind: "unavailable", failure: "server", status: response.status };
		if (!response.ok) return { kind: "malformed_response" };
		const parsed = parse(await boundedJsonBody(response, maxResponseBytes));
		return parsed === undefined ? { kind: "malformed_response" } : { kind: "found", ...parsed };
	}
	return {
		getCluster(clusterId, signal) {
			const id = positiveIdSchema.safeParse(clusterId);
			return id.success
				? get(`${API_ROOT}clusters/${id.data}/`, signal, (body) => {
						const parsed = clusterSchema
							.extend({
								sub_opinions: z.array(z.string().max(2_048)).max(maxOpinionsPerCluster),
							})
							.safeParse(body);
						const cluster = parsed.success ? clusterFrom(parsed.data) : undefined;
						return cluster === undefined || cluster.id !== id.data ? undefined : { cluster };
					})
				: Promise.resolve({ kind: "malformed_response" });
		},
		getOpinion(opinionUrl, signal) {
			const reference = trustedOpinionReference(opinionUrl);
			if (reference === undefined) return Promise.resolve({ kind: "malformed_response" });
			return get(opinionUrl, signal, (body) => {
				const parsed = opinionSchema
					.extend({
						html: z.string().max(maxSourceCharacters).nullable().optional(),
						html_with_citations: z.string().max(maxSourceCharacters).nullable().optional(),
						plain_text: z.string().max(maxSourceCharacters).nullable().optional(),
					})
					.safeParse(body);
				const opinion = parsed.success ? opinionFrom(parsed.data) : undefined;
				return opinion === undefined || opinion.id !== reference.id ? undefined : { opinion };
			});
		},
	};
}

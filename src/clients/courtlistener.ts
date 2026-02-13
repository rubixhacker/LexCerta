import { logger } from "../logger";
import { ApiError, RateLimitError } from "../resilience/circuit-breaker";

/** Minimal policy interface compatible with cockatiel IPolicy and test mocks */
export interface ExecutionPolicy {
	execute<T>(fn: (context: { signal: AbortSignal }) => Promise<T>): Promise<T>;
}

export interface CitationMatch {
	citation: string;
	normalized_citations: string[];
	start_index: number;
	end_index: number;
	status: number; // 200 = found, 404 = not found
	error_message: string;
	clusters: ClusterData[];
}

export interface ClusterData {
	absolute_url: string;
	case_name: string;
	case_name_short: string;
	date_filed: string;
	docket: {
		court: string;
		court_id: string;
	};
	citations: Array<{ volume: number; reporter: string; page: string }>;
}

export type LookupResponse =
	| { status: "ok"; matches: CitationMatch[] }
	| { status: "rate_limited"; retryAfterMs: number }
	| { status: "error"; code: string; message: string };

export interface OpinionText {
	opinionId: number;
	type: string; // "010combined", "020lead", "030concurrence", "040dissent", etc.
	plainText: string;
	clusterId: number;
}

export type OpinionTextResponse =
	| { status: "ok"; opinions: OpinionText[] }
	| { status: "rate_limited"; retryAfterMs: number }
	| { status: "error"; code: string; message: string }
	| { status: "not_found" };

export class CourtListenerClient {
	private readonly baseUrl: string;

	constructor(
		private readonly apiKey: string,
		private readonly policy: ExecutionPolicy,
		private readonly rateLimiter: {
			tryConsume(): boolean;
			msUntilNextToken(): number;
		},
		baseUrl = "https://www.courtlistener.com/api/rest/v4",
	) {
		this.baseUrl = baseUrl;
	}

	async lookupCitation(normalizedCitation: string): Promise<LookupResponse> {
		// Check rate limiter BEFORE entering the circuit breaker
		if (!this.rateLimiter.tryConsume()) {
			logger.warn("Rate limit exhausted, blocking request");
			return {
				status: "rate_limited",
				retryAfterMs: this.rateLimiter.msUntilNextToken(),
			};
		}

		try {
			const matches = await this.policy.execute(async ({ signal }: { signal: AbortSignal }) => {
				const response = await fetch(`${this.baseUrl}/citation-lookup/`, {
					method: "POST",
					headers: {
						Authorization: `Token ${this.apiKey}`,
						"Content-Type": "application/x-www-form-urlencoded",
					},
					body: `text=${encodeURIComponent(normalizedCitation)}`,
					signal,
				});

				// 429 must NOT be retried or counted as circuit breaker failure
				if (response.status === 429) {
					const retryAfter = response.headers.get("Retry-After");
					throw new RateLimitError(retryAfter ? Number.parseInt(retryAfter) * 1000 : 60_000);
				}

				// 5xx errors ARE retried and DO count toward circuit breaker
				if (response.status >= 500) {
					throw new ApiError(response.status, `Server error: ${response.status}`);
				}

				return (await response.json()) as CitationMatch[];
			});

			return { status: "ok", matches: matches as CitationMatch[] };
		} catch (err) {
			if (err instanceof RateLimitError) {
				return {
					status: "rate_limited",
					retryAfterMs: err.retryAfterMs,
				};
			}
			// Circuit breaker open or all retries exhausted
			const message = err instanceof Error ? err.message : "Unknown error";
			return { status: "error", code: "API_ERROR", message };
		}
	}

	async fetchClusterOpinions(clusterId: number): Promise<OpinionTextResponse> {
		// Check rate limiter BEFORE entering the circuit breaker
		if (!this.rateLimiter.tryConsume()) {
			logger.warn("Rate limit exhausted, blocking opinion fetch");
			return {
				status: "rate_limited",
				retryAfterMs: this.rateLimiter.msUntilNextToken(),
			};
		}

		try {
			const opinions = await this.policy.execute(async ({ signal }: { signal: AbortSignal }) => {
				const clusterResponse = await fetch(`${this.baseUrl}/clusters/${clusterId}/`, {
					headers: { Authorization: `Token ${this.apiKey}` },
					signal,
				});

				if (clusterResponse.status === 429) {
					const retryAfter = clusterResponse.headers.get("Retry-After");
					throw new RateLimitError(retryAfter ? Number.parseInt(retryAfter) * 1000 : 60_000);
				}

				if (clusterResponse.status === 404) {
					return null; // sentinel for not_found
				}

				if (clusterResponse.status >= 500) {
					throw new ApiError(clusterResponse.status, `Server error: ${clusterResponse.status}`);
				}

				const cluster = (await clusterResponse.json()) as {
					sub_opinions: string[];
				};

				// Fetch each sub-opinion (no additional rate limiter tokens)
				const results: OpinionText[] = [];
				for (const url of cluster.sub_opinions) {
					const opResponse = await fetch(url, {
						headers: {
							Authorization: `Token ${this.apiKey}`,
						},
						signal,
					});

					if (!opResponse.ok) {
						logger.warn(`Failed to fetch sub-opinion ${url}: ${opResponse.status}`);
						continue;
					}

					const op = (await opResponse.json()) as {
						id: number;
						type: string;
						plain_text: string;
						html: string;
					};

					let text = op.plain_text || "";
					if (!text && op.html) {
						text = op.html
							.replace(/<[^>]*>/g, "")
							.replace(/&[^;]+;/g, " ")
							.replace(/\s+/g, " ")
							.trim();
					}

					if (text) {
						results.push({
							opinionId: op.id,
							type: op.type,
							plainText: text,
							clusterId,
						});
					}
				}

				return results;
			});

			if (opinions === null) {
				return { status: "not_found" };
			}

			return { status: "ok", opinions };
		} catch (err) {
			if (err instanceof RateLimitError) {
				return {
					status: "rate_limited",
					retryAfterMs: err.retryAfterMs,
				};
			}
			const message = err instanceof Error ? err.message : "Unknown error";
			return { status: "error", code: "API_ERROR", message };
		}
	}
}

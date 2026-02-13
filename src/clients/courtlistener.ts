import { logger } from "../logger.js";
import { ApiError, RateLimitError } from "../resilience/circuit-breaker.js";

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
}

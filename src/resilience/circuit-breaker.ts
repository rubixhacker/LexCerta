import {
	ConsecutiveBreaker,
	ExponentialBackoff,
	TimeoutStrategy,
	circuitBreaker,
	handleType,
	retry,
	timeout,
	wrap,
} from "cockatiel";
import { logger } from "../logger.js";

// Custom error types for response classification
export class RateLimitError extends Error {
	constructor(public retryAfterMs: number) {
		super(`Rate limited. Retry after ${retryAfterMs}ms`);
		this.name = "RateLimitError";
	}
}

export class ApiError extends Error {
	constructor(
		public statusCode: number,
		message: string,
	) {
		super(message);
		this.name = "ApiError";
	}
}

// Only handle 5xx server errors -- NOT RateLimitError, NOT 404
const serverErrorPolicy = handleType(ApiError, (err) => err.statusCode >= 500);

// Circuit breaker: open after 5 consecutive 5xx failures, half-open after 30s
export const courtListenerBreaker = circuitBreaker(serverErrorPolicy, {
	halfOpenAfter: 30_000,
	breaker: new ConsecutiveBreaker(5),
});

// Timeout: 5s per request
const timeoutPolicy = timeout(5_000, TimeoutStrategy.Aggressive);

// Retry: up to 2 retries with exponential backoff (only on 5xx, not 429)
const retryPolicy = retry(serverErrorPolicy, {
	maxAttempts: 2,
	backoff: new ExponentialBackoff({
		initialDelay: 500,
		maxDelay: 3_000,
	}),
});

// Compose: outer retry -> circuit breaker -> inner timeout
export const courtListenerPolicy = wrap(retryPolicy, courtListenerBreaker, timeoutPolicy);

// Observable events for logging
courtListenerBreaker.onBreak(() => {
	logger.error("[CIRCUIT] CourtListener circuit breaker OPENED");
});
courtListenerBreaker.onReset(() => {
	logger.info("[CIRCUIT] CourtListener circuit breaker CLOSED");
});
courtListenerBreaker.onHalfOpen(() => {
	logger.info("[CIRCUIT] CourtListener circuit breaker HALF-OPEN");
});

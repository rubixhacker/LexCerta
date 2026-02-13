import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TokenBucketRateLimiter } from "../rate-limiter.js";

describe("TokenBucketRateLimiter", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("tryConsume() returns true when tokens are available", () => {
		const limiter = new TokenBucketRateLimiter(10, 3_600_000);
		expect(limiter.tryConsume()).toBe(true);
	});

	it("tryConsume() decrements token count", () => {
		const limiter = new TokenBucketRateLimiter(10, 3_600_000);
		limiter.tryConsume();
		expect(limiter.remaining).toBe(9);
	});

	it("tryConsume() returns false when all tokens are exhausted", () => {
		const limiter = new TokenBucketRateLimiter(3, 3_600_000);
		expect(limiter.tryConsume()).toBe(true);
		expect(limiter.tryConsume()).toBe(true);
		expect(limiter.tryConsume()).toBe(true);
		expect(limiter.tryConsume()).toBe(false);
	});

	it("remaining reflects current token count", () => {
		const limiter = new TokenBucketRateLimiter(5, 3_600_000);
		expect(limiter.remaining).toBe(5);
		limiter.tryConsume();
		limiter.tryConsume();
		expect(limiter.remaining).toBe(3);
	});

	it("tokens refill proportionally over time", () => {
		const limiter = new TokenBucketRateLimiter(100, 3_600_000);
		// Consume all tokens
		for (let i = 0; i < 100; i++) {
			limiter.tryConsume();
		}
		expect(limiter.remaining).toBe(0);

		// Advance half the refill interval
		vi.advanceTimersByTime(1_800_000); // 30 minutes = half of 1 hour
		expect(limiter.remaining).toBe(50);
	});

	it("msUntilNextToken() returns 0 when tokens are available", () => {
		const limiter = new TokenBucketRateLimiter(10, 3_600_000);
		expect(limiter.msUntilNextToken()).toBe(0);
	});

	it("msUntilNextToken() returns positive value when exhausted", () => {
		const limiter = new TokenBucketRateLimiter(10, 3_600_000);
		for (let i = 0; i < 10; i++) {
			limiter.tryConsume();
		}
		const ms = limiter.msUntilNextToken();
		expect(ms).toBeGreaterThan(0);
		// For 10 tokens in 3600000ms, each token takes 360000ms
		expect(ms).toBeLessThanOrEqual(360_000);
	});

	it("tokens cap at maxTokens and never exceed initial capacity", () => {
		const limiter = new TokenBucketRateLimiter(10, 3_600_000);
		// Don't consume any tokens, advance a full refill interval
		vi.advanceTimersByTime(7_200_000); // 2 hours
		expect(limiter.remaining).toBe(10); // Capped at maxTokens
	});

	it("tryConsume(count) consumes multiple tokens at once", () => {
		const limiter = new TokenBucketRateLimiter(10, 3_600_000);
		expect(limiter.tryConsume(5)).toBe(true);
		expect(limiter.remaining).toBe(5);
		expect(limiter.tryConsume(6)).toBe(false);
		expect(limiter.remaining).toBe(5); // Unchanged after failed consume
	});
});

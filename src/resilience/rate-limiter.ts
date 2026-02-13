export class TokenBucketRateLimiter {
	private tokens: number;
	private lastRefill: number;

	constructor(
		private readonly maxTokens: number = 4500, // 90% of CourtListener's 5,000/hr
		private readonly refillIntervalMs: number = 3_600_000, // 1 hour
	) {
		this.tokens = maxTokens;
		this.lastRefill = Date.now();
	}

	tryConsume(count = 1): boolean {
		this.refill();
		if (this.tokens >= count) {
			this.tokens -= count;
			return true;
		}
		return false;
	}

	msUntilNextToken(): number {
		this.refill();
		if (this.tokens > 0) return 0;
		const msPerToken = this.refillIntervalMs / this.maxTokens;
		const elapsed = Date.now() - this.lastRefill;
		return Math.max(0, Math.ceil(msPerToken - (elapsed % msPerToken)));
	}

	get remaining(): number {
		this.refill();
		return Math.floor(this.tokens);
	}

	private refill(): void {
		const now = Date.now();
		const elapsed = now - this.lastRefill;
		if (elapsed <= 0) return;
		const tokensToAdd = (elapsed / this.refillIntervalMs) * this.maxTokens;
		this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
		this.lastRefill = now;
	}
}

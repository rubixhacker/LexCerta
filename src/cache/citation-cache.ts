import { LRUCache } from "lru-cache";
import type { CitationMatch } from "../clients/courtlistener";

export interface CachedLookup {
	matches: CitationMatch[];
}

export interface CacheStats {
	size: number;
	maxSize: number;
	hits: number;
	misses: number;
}

export class CitationCache {
	private readonly cache: LRUCache<string, CachedLookup>;
	private hitCount = 0;
	private missCount = 0;

	constructor(maxEntries = 1000) {
		this.cache = new LRUCache<string, CachedLookup>({ max: maxEntries });
	}

	get(normalizedCitation: string): CachedLookup | undefined {
		const result = this.cache.get(normalizedCitation);
		if (result !== undefined) {
			this.hitCount++;
		} else {
			this.missCount++;
		}
		return result;
	}

	set(normalizedCitation: string, result: CachedLookup): void {
		this.cache.set(normalizedCitation, result);
	}

	stats(): CacheStats {
		return {
			size: this.cache.size,
			maxSize: this.cache.max,
			hits: this.hitCount,
			misses: this.missCount,
		};
	}

	clear(): void {
		this.cache.clear();
		this.hitCount = 0;
		this.missCount = 0;
	}
}

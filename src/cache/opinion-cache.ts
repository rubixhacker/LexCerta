import { LRUCache } from "lru-cache";
import type { OpinionText } from "../clients/courtlistener";

export interface CachedOpinionText {
	opinions: OpinionText[];
}

export interface OpinionCacheStats {
	size: number;
	maxSize: number;
	hits: number;
	misses: number;
}

export class OpinionCache {
	private readonly cache: LRUCache<string, CachedOpinionText>;
	private hitCount = 0;
	private missCount = 0;

	constructor(maxEntries = 200) {
		this.cache = new LRUCache<string, CachedOpinionText>({
			max: maxEntries,
		});
	}

	get(clusterId: number): CachedOpinionText | undefined {
		const result = this.cache.get(String(clusterId));
		if (result !== undefined) {
			this.hitCount++;
		} else {
			this.missCount++;
		}
		return result;
	}

	set(clusterId: number, result: CachedOpinionText): void {
		this.cache.set(String(clusterId), result);
	}

	stats(): OpinionCacheStats {
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

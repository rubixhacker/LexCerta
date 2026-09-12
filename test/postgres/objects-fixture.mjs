// Models immutable generations for PostgreSQL race tests. This is not GCS/IAM proof.
export class FixtureSourceObjects {
	values = new Map();
	nextGeneration = 1;
	onPut;
	onRead;
	onRemove;
	onBeforePut;
	async put(key, bytes, metadata) {
		await this.onBeforePut?.(key);
		if (this.values.has(key)) throw new Error("immutable object conflict");
		const value = {
			generation: String(this.nextGeneration++),
			bytes: Uint8Array.from(bytes),
			metadata: { ...metadata },
			createdAt: new Date(),
		};
		this.values.set(key, value);
		await this.onPut?.(key, value);
		return value;
	}
	async read(key, generation) {
		const value = this.values.get(key);
		await this.onRead?.(key, value);
		return value?.generation === generation ? value : null;
	}
	async generation(key) {
		return this.values.get(key)?.generation ?? null;
	}
	async remove(key, generation) {
		await this.onRemove?.(key, generation);
		const value = this.values.get(key);
		if (value === undefined) return;
		if (value.generation !== generation) throw new Error("generation precondition failed");
		this.values.delete(key);
	}
	async list() {
		return {
			objects: [...this.values].map(([key, value]) => ({
				key,
				generation: value.generation,
				createdAt: value.createdAt,
			})),
			nextPageToken: null,
		};
	}
}

export function deferred() {
	let resolve;
	const promise = new Promise((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

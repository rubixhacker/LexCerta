import { createHash } from "node:crypto";
import { type Bucket, Storage } from "@google-cloud/storage";

export const MAX_SOURCE_OBJECT_BYTES = 1_048_576;
export type SourceObjectMetadata = Readonly<Record<string, string>>;
export type SourceObjectVersion = {
	readonly generation: string;
	readonly bytes: Uint8Array;
	readonly metadata: SourceObjectMetadata;
};
export type ListedSourceObject = {
	readonly key: string;
	readonly generation: string;
	readonly createdAt: Date;
};
export type SourceObjectPage = {
	readonly objects: readonly ListedSourceObject[];
	readonly nextPageToken: string | null;
};
export interface SourceObjects {
	put(key: string, bytes: Uint8Array, metadata: SourceObjectMetadata): Promise<SourceObjectVersion>;
	read(key: string, generation: string): Promise<SourceObjectVersion | null>;
	generation(key: string): Promise<string | null>;
	remove(key: string, generation: string): Promise<void>;
	list(pageToken?: string): Promise<SourceObjectPage>;
}

export class SourceObjectIntegrityError extends Error {
	readonly name = "SourceObjectIntegrityError";
	constructor() {
		super("source object unavailable or inconsistent");
	}
}

export function sourceHash(bytes: Uint8Array): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function createGcsSourceObjects(bucket: string): SourceObjects {
	const storage = new Storage({ timeout: 5000, retryOptions: { autoRetry: false, maxRetries: 0 } });
	return new GcsSourceObjects(storage.bucket(bucket));
}

export class GcsSourceObjects implements SourceObjects {
	constructor(private readonly bucket: Bucket) {}

	async put(
		key: string,
		bytes: Uint8Array,
		metadata: SourceObjectMetadata,
	): Promise<SourceObjectVersion> {
		if (bytes.byteLength < 1 || bytes.byteLength > MAX_SOURCE_OBJECT_BYTES)
			throw new SourceObjectIntegrityError();
		const file = this.bucket.file(key);
		await file.save(Buffer.from(bytes), {
			resumable: false,
			gzip: false,
			timeout: 5000,
			validation: "crc32c",
			preconditionOpts: { ifGenerationMatch: 0 },
			metadata: {
				contentType: "text/plain; charset=utf-8",
				cacheControl: "no-store",
				metadata: { ...metadata },
			},
		});
		const generation = await this.generation(key);
		if (generation === null) throw new SourceObjectIntegrityError();
		const stored = await this.read(key, generation);
		if (
			stored === null ||
			sourceHash(stored.bytes) !== sourceHash(bytes) ||
			!sameMetadata(stored.metadata, metadata)
		)
			throw new SourceObjectIntegrityError();
		return stored;
	}

	async read(key: string, generation: string): Promise<SourceObjectVersion | null> {
		try {
			const file = this.exactGeneration(key, generation);
			const [metadata] = await file.getMetadata();
			if (
				String(metadata.generation) !== generation ||
				!Number.isSafeInteger(Number(metadata.size)) ||
				Number(metadata.size) < 1 ||
				Number(metadata.size) > MAX_SOURCE_OBJECT_BYTES ||
				metadata.contentEncoding
			)
				throw new SourceObjectIntegrityError();
			const stream = file.createReadStream({ decompress: false, validation: "crc32c" });
			const timer = setTimeout(() => stream.destroy(new SourceObjectIntegrityError()), 5000);
			const chunks: Buffer[] = [];
			let total = 0;
			try {
				for await (const value of stream) {
					const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
					total += chunk.byteLength;
					if (total > MAX_SOURCE_OBJECT_BYTES) {
						stream.destroy();
						throw new SourceObjectIntegrityError();
					}
					chunks.push(chunk);
				}
			} finally {
				clearTimeout(timer);
				stream.destroy();
			}
			if (total !== Number(metadata.size)) throw new SourceObjectIntegrityError();
			const custom: Record<string, string> = {};
			for (const [name, value] of Object.entries(metadata.metadata ?? {})) {
				if (typeof value !== "string") throw new SourceObjectIntegrityError();
				custom[name] = value;
			}
			return { generation, bytes: Buffer.concat(chunks), metadata: custom };
		} catch (error) {
			if (hasCode(error, 404)) return null;
			throw error;
		}
	}

	async generation(key: string): Promise<string | null> {
		try {
			const [metadata] = await this.bucket.file(key).getMetadata();
			const generation = String(metadata.generation);
			if (!/^\d{1,32}$/.test(generation)) throw new SourceObjectIntegrityError();
			return generation;
		} catch (error) {
			if (hasCode(error, 404)) return null;
			throw error;
		}
	}

	async remove(key: string, generation: string): Promise<void> {
		try {
			await this.exactGeneration(key, generation).delete({ ifGenerationMatch: generation });
		} catch (error) {
			if (!hasCode(error, 404)) throw error;
		}
	}

	private exactGeneration(key: string, generation: string) {
		if (!/^\d{1,32}$/.test(generation)) throw new SourceObjectIntegrityError();
		const file = this.bucket.file(key);
		// The pinned SDK coerces FileOptions.generation to Number. A per-file
		// public request interceptor preserves the exact decimal generation for
		// metadata, media and deletion, including values above MAX_SAFE_INTEGER.
		file.interceptors.push({
			request: (options) => ({
				...options,
				uri: "uri" in options ? options.uri : options.url,
				qs: { ...options.qs, generation },
			}),
		});
		return file;
	}

	async list(pageToken?: string): Promise<SourceObjectPage> {
		const [files, next] = await this.bucket.getFiles({
			prefix: "opinions/",
			versions: true,
			maxResults: 100,
			autoPaginate: false,
			...(pageToken === undefined ? {} : { pageToken }),
		});
		const objects = files.map((file) => {
			const generation = String(file.metadata.generation);
			const createdAt = new Date(file.metadata.timeCreated ?? "");
			if (!/^\d{1,32}$/.test(generation) || !Number.isFinite(createdAt.getTime()))
				throw new SourceObjectIntegrityError();
			return { key: file.name, generation, createdAt };
		});
		return { objects, nextPageToken: next?.pageToken ?? null };
	}
}

export function sameMetadata(left: SourceObjectMetadata, right: SourceObjectMetadata): boolean {
	return (
		Object.keys(left).length === Object.keys(right).length &&
		Object.entries(right).every(([key, value]) => left[key] === value)
	);
}
function hasCode(error: unknown, code: number): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

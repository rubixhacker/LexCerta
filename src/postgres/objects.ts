import { createHash } from "node:crypto";

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

export function sameMetadata(left: SourceObjectMetadata, right: SourceObjectMetadata): boolean {
	return (
		Object.keys(left).length === Object.keys(right).length &&
		Object.entries(right).every(([key, value]) => left[key] === value)
	);
}

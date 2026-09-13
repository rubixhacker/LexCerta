import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
	MAX_SOURCE_OBJECT_BYTES,
	SourceObjectIntegrityError,
	type SourceObjectMetadata,
	type SourceObjectVersion,
	type SourceObjectPage,
	type SourceObjects,
	sameMetadata,
	sourceHash,
} from "../postgres/objects.js";
import { EvidenceRequest } from "../verification/evidence-request.js";
import { readHttpBody, readHttpJson } from "./http-body.js";
import { type AccessTokenProvider, createMetadataAccessTokenProvider } from "./metadata-token.js";

class SourceObjectHttpError extends SourceObjectIntegrityError {
	constructor(readonly code: number) {
		super();
	}
}

const Generation = z.string().regex(/^\d{1,32}$/);
const CustomMetadata = z.record(z.string(), z.string());
const ObjectMetadata = z.object({
	name: z.string(),
	generation: Generation,
	size: z.string().regex(/^\d+$/),
	md5Hash: z.string().regex(/^[A-Za-z0-9+/]{22}==$/),
	contentEncoding: z.string().optional(),
	metadata: CustomMetadata.optional(),
});
const ObjectPage = z.object({
	items: z
		.array(z.object({ name: z.string(), generation: Generation, timeCreated: z.iso.datetime() }))
		.max(100)
		.optional(),
	nextPageToken: z.string().min(1).max(8192).optional(),
});
const METADATA_FIELDS = "name,generation,size,md5Hash,contentEncoding,metadata";
type GcsOptions = {
	readonly accessToken: AccessTokenProvider;
	readonly endpoint?: string;
	readonly signal?: AbortSignal;
};

export function createGcsSourceObjects(bucket: string): GcsSourceObjects {
	return new GcsSourceObjects(bucket, { accessToken: createMetadataAccessTokenProvider() });
}

// Native fetch gives this small JSON API surface one cancellation signal for
// auth, headers, upload and response bodies. No automatic retry or redirect can
// issue work beyond that operation. Immutable publication remains owned by SQL.
export class GcsSourceObjects implements SourceObjects {
	readonly #origin: string;
	readonly #objectsPath: string;
	constructor(
		private readonly bucket: string,
		private readonly options: GcsOptions,
	) {
		if (!/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/.test(bucket)) throw new SourceObjectIntegrityError();
		const endpoint = new URL(options.endpoint ?? "https://storage.googleapis.com");
		if (
			(endpoint.origin !== "https://storage.googleapis.com" &&
				!(endpoint.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(endpoint.hostname))) ||
			endpoint.pathname !== "/" ||
			endpoint.search ||
			endpoint.hash ||
			endpoint.username ||
			endpoint.password
		)
			throw new SourceObjectIntegrityError();
		this.#origin = endpoint.origin;
		this.#objectsPath = `/storage/v1/b/${encodeURIComponent(bucket)}/o`;
	}

	withSignal(signal: AbortSignal): GcsSourceObjects {
		return new GcsSourceObjects(this.bucket, {
			...this.options,
			signal:
				this.options.signal === undefined ? signal : AbortSignal.any([this.options.signal, signal]),
		});
	}

	put(
		key: string,
		bytes: Uint8Array,
		metadata: SourceObjectMetadata,
	): Promise<SourceObjectVersion> {
		return this.run(async (request) => {
			this.keyPath(key);
			if (bytes.byteLength < 1 || bytes.byteLength > MAX_SOURCE_OBJECT_BYTES)
				throw new SourceObjectIntegrityError();
			const boundary = `lexcerta-${randomUUID()}`;
			const encodedMetadata = JSON.stringify({
				name: key,
				contentType: "text/plain; charset=utf-8",
				cacheControl: "no-store",
				md5Hash: transferHash(bytes),
				metadata: CustomMetadata.parse(metadata),
			});
			if (Buffer.byteLength(encodedMetadata) > 16_384) throw new SourceObjectIntegrityError();
			const body = Buffer.concat([
				Buffer.from(
					`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${encodedMetadata}\r\n--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n`,
				),
				bytes,
				Buffer.from(`\r\n--${boundary}--\r\n`),
			]);
			const response = await this.fetch(
				request,
				`/upload${this.#objectsPath}`,
				{
					name: key,
					uploadType: "multipart",
					ifGenerationMatch: "0",
					fields: METADATA_FIELDS,
				},
				{
					method: "POST",
					headers: { "content-type": `multipart/related; boundary=${boundary}` },
					body,
				},
			);
			const uploaded = ObjectMetadata.parse(await readHttpJson(response, 65_536, request.signal));
			this.validateMetadata(uploaded, key, uploaded.generation);
			const stored = await this.readWithin(request, key, uploaded.generation);
			if (
				stored === null ||
				sourceHash(stored.bytes) !== sourceHash(bytes) ||
				!sameMetadata(stored.metadata, metadata)
			)
				throw new SourceObjectIntegrityError();
			return stored;
		});
	}

	read(key: string, generation: string): Promise<SourceObjectVersion | null> {
		return this.run((request) => this.readWithin(request, key, generation));
	}

	private async readWithin(
		request: EvidenceRequest,
		key: string,
		generation: string,
	): Promise<SourceObjectVersion | null> {
		Generation.parse(generation);
		try {
			const metadataResponse = await this.fetch(request, this.keyPath(key), {
				generation,
				fields: METADATA_FIELDS,
			});
			const metadata = ObjectMetadata.parse(
				await readHttpJson(metadataResponse, 65_536, request.signal),
			);
			this.validateMetadata(metadata, key, generation);
			const response = await this.fetch(request, this.keyPath(key), { generation, alt: "media" });
			const bytes = await readHttpBody(response, MAX_SOURCE_OBJECT_BYTES, request.signal);
			const hash = transferHash(bytes);
			const advertised = response.headers
				.get("x-goog-hash")
				?.split(",")
				.map((value) => value.trim())
				.find((value) => value.startsWith("md5="));
			if (
				bytes.byteLength !== Number(metadata.size) ||
				hash !== metadata.md5Hash ||
				(advertised !== undefined && advertised !== `md5=${hash}`)
			)
				throw new SourceObjectIntegrityError();
			return { generation, bytes, metadata: metadata.metadata ?? {} };
		} catch (error) {
			if (error instanceof SourceObjectHttpError && error.code === 404) return null;
			throw error;
		}
	}

	generation(key: string): Promise<string | null> {
		return this.run(async (request) => {
			try {
				const response = await this.fetch(request, this.keyPath(key), { fields: "generation" });
				return z
					.object({ generation: Generation })
					.parse(await readHttpJson(response, 65_536, request.signal)).generation;
			} catch (error) {
				if (error instanceof SourceObjectHttpError && error.code === 404) return null;
				throw error;
			}
		});
	}

	remove(key: string, generation: string): Promise<void> {
		return this.run(async (request) => {
			Generation.parse(generation);
			try {
				const response = await this.fetch(
					request,
					this.keyPath(key),
					{ generation, ifGenerationMatch: generation },
					{ method: "DELETE" },
				);
				void response.body?.cancel().catch(() => undefined);
				if (response.status !== 204) throw new SourceObjectIntegrityError();
			} catch (error) {
				if (!(error instanceof SourceObjectHttpError && error.code === 404)) throw error;
			}
		});
	}

	list(pageToken?: string): Promise<SourceObjectPage> {
		return this.run(async (request) => {
			if (pageToken !== undefined && (pageToken.length < 1 || pageToken.length > 8192))
				throw new SourceObjectIntegrityError();
			const response = await this.fetch(request, this.#objectsPath, {
				prefix: "opinions/",
				versions: "true",
				maxResults: "100",
				fields: "items(name,generation,timeCreated),nextPageToken",
				...(pageToken === undefined ? {} : { pageToken }),
			});
			const page = ObjectPage.parse(await readHttpJson(response, 131_072, request.signal));
			const objects = (page.items ?? []).map((file) => {
				this.keyPath(file.name);
				return {
					key: file.name,
					generation: file.generation,
					createdAt: new Date(file.timeCreated),
				};
			});
			return { objects, nextPageToken: page.nextPageToken ?? null };
		});
	}

	private keyPath(key: string): string {
		if (!key.startsWith("opinions/") || Buffer.byteLength(key) > 1024 || !key.isWellFormed())
			throw new SourceObjectIntegrityError();
		return `${this.#objectsPath}/${encodeURIComponent(key)}`;
	}

	private validateMetadata(
		metadata: z.infer<typeof ObjectMetadata>,
		key: string,
		generation: string,
	): void {
		const size = Number(metadata.size);
		if (
			metadata.name !== key ||
			metadata.generation !== generation ||
			!Number.isSafeInteger(size) ||
			size < 1 ||
			size > MAX_SOURCE_OBJECT_BYTES ||
			metadata.contentEncoding
		)
			throw new SourceObjectIntegrityError();
	}

	private async fetch(
		request: EvidenceRequest,
		path: string,
		query: Record<string, string>,
		init: RequestInit = {},
	): Promise<Response> {
		const token = await request.run(() => this.options.accessToken(request.signal));
		request.checkpoint();
		if (!/^[A-Za-z0-9._~+/-]+=*$/.test(token) || token.length > 8192)
			throw new SourceObjectIntegrityError();
		const url = new URL(path, this.#origin);
		url.search = new URLSearchParams(query).toString();
		const headers = new Headers(init.headers);
		headers.set("authorization", `Bearer ${token}`);
		headers.set("accept-encoding", "identity");
		const response = await fetch(url, {
			...init,
			headers,
			signal: request.signal,
			redirect: "manual",
		});
		if (
			response.status !== (init.method === "DELETE" ? 204 : 200) ||
			(response.headers.has("content-encoding") &&
				response.headers.get("content-encoding") !== "identity")
		) {
			void response.body?.cancel().catch(() => undefined);
			throw new SourceObjectHttpError(response.status);
		}
		return response;
	}

	private async run<T>(operation: (request: EvidenceRequest) => Promise<T>): Promise<T> {
		const request = new EvidenceRequest({
			timeoutMs: 5000,
			...(this.options.signal === undefined ? {} : { signal: this.options.signal }),
		});
		try {
			return await request.run(() => operation(request));
		} catch (error) {
			if (error instanceof SourceObjectIntegrityError) throw error;
			throw new SourceObjectIntegrityError();
		} finally {
			request.close();
		}
	}
}

function transferHash(bytes: Uint8Array): string {
	// GCS validates this during a single multipart upload. SQL independently
	// binds the immutable bytes to their SHA-256 content hash.
	return createHash("md5").update(bytes).digest("base64");
}

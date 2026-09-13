import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
	decodeRecoveryRecord,
	encodeRecoveryRecord,
	MAX_RECOVERY_RECORD_BYTES,
	RecoveryJournalUnavailable,
	type RecoveryJournalReader,
	type RecoveryJournalWriter,
	type RecoveryObject,
	type RecoveryRecord,
	type RecoveryRestriction,
} from "../postgres/recovery-journal.js";
import { EvidenceRequest } from "../verification/evidence-request.js";
import { readHttpBody, readHttpJson } from "./http-body.js";
import { type AccessTokenProvider, createMetadataAccessTokenProvider } from "./metadata-token.js";

const Generation = z.string().regex(/^[1-9]\d{0,31}$/);
const Reference = z.object({
	name: z.string(),
	generation: Generation,
	timeCreated: z.iso.datetime(),
});
const Metadata = Reference.extend({
	size: z.string().regex(/^\d{1,10}$/),
	md5Hash: z.string().regex(/^[A-Za-z0-9+/]{22}==$/),
	contentEncoding: z.string().optional(),
});
const Page = z.object({
	items: z.array(Reference).max(100).optional(),
	nextPageToken: z.string().min(1).max(8192).optional(),
});
const FIELDS = "name,generation,timeCreated,size,md5Hash,contentEncoding";
type Options = { readonly accessToken: AccessTokenProvider; readonly endpoint?: string };

export function createGcsRecoveryJournal(
	bucket: string,
	environment: RecoveryRecord["environment"],
) {
	return new GcsRecoveryJournal(bucket, environment, {
		accessToken: createMetadataAccessTokenProvider(),
	});
}

// Dedicated bucket, create/get/list only. No update/delete API, redirect or
// automatic HTTP retry. A 412 is resolved by verifying the existing bytes.
export class GcsRecoveryJournal implements RecoveryJournalWriter, RecoveryJournalReader {
	readonly #origin: string;
	readonly #objectsPath: string;
	readonly #prefix: string;
	constructor(
		bucket: string,
		readonly environment: RecoveryRecord["environment"],
		private readonly options: Options,
	) {
		if (
			!/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/.test(bucket) ||
			!["staging", "production"].includes(environment)
		)
			throw new RecoveryJournalUnavailable();
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
			throw new RecoveryJournalUnavailable();
		this.#origin = endpoint.origin;
		this.#objectsPath = `/storage/v1/b/${encodeURIComponent(bucket)}/o`;
		this.#prefix = `restrictions/v1/${environment}/`;
	}

	append(restriction: RecoveryRestriction, signal?: AbortSignal): Promise<RecoveryObject> {
		return this.run(signal, async (request) => {
			const { key, bytes } = encodeRecoveryRecord({
				version: 1,
				environment: this.environment,
				restriction,
			});
			const boundary = `lexcerta-${randomUUID()}`;
			const metadata = JSON.stringify({
				name: key,
				contentType: "application/json",
				cacheControl: "no-store",
				md5Hash: md5(bytes),
			});
			const body = Buffer.concat([
				Buffer.from(
					`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n`,
				),
				bytes,
				Buffer.from(`\r\n--${boundary}--\r\n`),
			]);
			const response = await this.fetch(
				request,
				`/upload${this.#objectsPath}`,
				{ name: key, uploadType: "multipart", ifGenerationMatch: "0", fields: FIELDS },
				{
					method: "POST",
					headers: { "content-type": `multipart/related; boundary=${boundary}` },
					body,
				},
			);
			let stored: z.infer<typeof Metadata>;
			if (response.status === 412) {
				void response.body?.cancel().catch(() => undefined);
				stored = await this.metadata(request, key);
			} else {
				this.requireSuccess(response);
				stored = Metadata.parse(await readHttpJson(response, 16_384, request.signal));
			}
			const object = this.reference(stored);
			if (object.key !== key) throw new RecoveryJournalUnavailable();
			await this.readWithin(request, object);
			return object;
		});
	}

	list(pageToken?: string, signal?: AbortSignal) {
		return this.run(signal, async (request) => {
			if (pageToken !== undefined) z.string().min(1).max(8192).parse(pageToken);
			const response = await this.fetch(request, this.#objectsPath, {
				prefix: this.#prefix,
				maxResults: "100",
				versions: "false",
				fields: "items(name,generation,timeCreated),nextPageToken",
				...(pageToken === undefined ? {} : { pageToken }),
			});
			this.requireSuccess(response);
			const page = Page.parse(await readHttpJson(response, 65_536, request.signal));
			const objects = (page.items ?? []).map((entry) => this.reference(entry));
			if (
				new Set(objects.map((entry) => entry.key)).size !== objects.length ||
				(pageToken !== undefined && page.nextPageToken === pageToken)
			)
				throw new RecoveryJournalUnavailable();
			return { objects, nextPageToken: page.nextPageToken ?? null };
		});
	}

	read(object: RecoveryObject, signal?: AbortSignal): Promise<RecoveryRecord> {
		return this.run(signal, (request) => this.readWithin(request, object));
	}

	private async readWithin(
		request: EvidenceRequest,
		object: RecoveryObject,
	): Promise<RecoveryRecord> {
		Generation.parse(object.generation);
		z.iso.datetime().parse(object.createdAt);
		const metadata = await this.metadata(request, object.key, object.generation);
		const size = Number(metadata.size);
		if (
			metadata.name !== object.key ||
			metadata.generation !== object.generation ||
			metadata.timeCreated !== object.createdAt ||
			size < 1 ||
			size > MAX_RECOVERY_RECORD_BYTES ||
			metadata.contentEncoding
		)
			throw new RecoveryJournalUnavailable();
		const response = await this.fetch(request, this.keyPath(object.key), {
			generation: object.generation,
			alt: "media",
		});
		this.requireSuccess(response);
		const bytes = await readHttpBody(response, MAX_RECOVERY_RECORD_BYTES, request.signal);
		const hash = md5(bytes);
		const advertised = response.headers
			.get("x-goog-hash")
			?.split(",")
			.map((part) => part.trim())
			.find((part) => part.startsWith("md5="));
		if (
			bytes.length !== size ||
			hash !== metadata.md5Hash ||
			(advertised !== undefined && advertised !== `md5=${hash}`)
		)
			throw new RecoveryJournalUnavailable();
		return decodeRecoveryRecord(bytes, object.key, this.environment);
	}

	private async metadata(request: EvidenceRequest, key: string, generation?: string) {
		const response = await this.fetch(request, this.keyPath(key), {
			fields: FIELDS,
			...(generation === undefined ? {} : { generation }),
		});
		this.requireSuccess(response);
		return Metadata.parse(await readHttpJson(response, 16_384, request.signal));
	}

	private reference(value: z.infer<typeof Reference>): RecoveryObject {
		this.keyPath(value.name);
		return { key: value.name, generation: value.generation, createdAt: value.timeCreated };
	}

	private keyPath(key: string): string {
		if (
			!key.startsWith(this.#prefix) ||
			!/^[a-f0-9]{64}\.json$/.test(key.slice(this.#prefix.length))
		)
			throw new RecoveryJournalUnavailable();
		return `${this.#objectsPath}/${encodeURIComponent(key)}`;
	}

	private async fetch(
		request: EvidenceRequest,
		path: string,
		query: Record<string, string>,
		init: RequestInit = {},
	) {
		const token = await request.run(() => this.options.accessToken(request.signal));
		request.checkpoint();
		if (!/^[A-Za-z0-9._~+/-]+=*$/.test(token) || token.length > 8192)
			throw new RecoveryJournalUnavailable();
		const url = new URL(path, this.#origin);
		url.search = new URLSearchParams(query).toString();
		const headers = new Headers(init.headers);
		headers.set("authorization", `Bearer ${token}`);
		headers.set("accept-encoding", "identity");
		return fetch(url, { ...init, headers, signal: request.signal, redirect: "manual" });
	}

	private requireSuccess(response: Response) {
		if (
			response.status !== 200 ||
			(response.headers.has("content-encoding") &&
				response.headers.get("content-encoding") !== "identity")
		) {
			void response.body?.cancel().catch(() => undefined);
			throw new RecoveryJournalUnavailable();
		}
	}

	private async run<T>(
		signal: AbortSignal | undefined,
		operation: (request: EvidenceRequest) => Promise<T>,
	): Promise<T> {
		const request = new EvidenceRequest({
			timeoutMs: 5000,
			...(signal === undefined ? {} : { signal }),
		});
		try {
			return await request.run(() => operation(request));
		} catch {
			throw new RecoveryJournalUnavailable();
		} finally {
			request.close();
		}
	}
}

function md5(bytes: Uint8Array): string {
	return createHash("md5").update(bytes).digest("base64");
}

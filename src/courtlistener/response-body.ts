import { z } from "zod";
import { abortable, type EvidenceRequest } from "../verification/evidence-request.js";

export const MAX_RESPONSE_BODY_BYTES = 65_536;

function declaredLength(response: Response): number | undefined {
	const value = response.headers.get("content-length");
	if (value === null) return undefined;
	const parsed = z.string().trim().regex(/^\d+$/).safeParse(value);
	if (!parsed.success) return undefined;
	const length = Number(parsed.data);
	return Number.isSafeInteger(length) ? length : undefined;
}

function cancel(
	source: ReadableStreamDefaultReader<Uint8Array> | ReadableStream<Uint8Array>,
): void {
	try {
		// An upstream cancellation hook may never settle. Request cancellation
		// immediately, but never extend the evidence deadline waiting for its ack.
		void source.cancel().catch(() => undefined);
	} catch {
		return;
	}
}

export function discardResponse(response: Response): void {
	if (response.body !== null) cancel(response.body);
}

export async function boundedJsonBody(
	response: Response,
	maxBytes = MAX_RESPONSE_BODY_BYTES,
	options: { readonly signal?: AbortSignal; readonly request?: EvidenceRequest } = {},
): Promise<unknown | undefined> {
	const signal = options.signal ?? AbortSignal.timeout(5_000);
	const declared = declaredLength(response);
	const stream = response.body;
	if (declared !== undefined && declared > maxBytes) {
		if (stream !== null) cancel(stream);
		return undefined;
	}
	if (stream === null) return undefined;
	const reader = stream.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
	let length = 0;
	let text = "";
	try {
		while (true) {
			options.request?.checkpoint();
			const chunk = await abortable(() => reader.read(), signal);
			if (chunk.done) break;
			length += chunk.value.byteLength;
			options.request?.consumeResponseBytes(chunk.value.byteLength);
			if (length > maxBytes) {
				cancel(reader);
				return undefined;
			}
			text += decoder.decode(chunk.value, { stream: true });
		}
		options.request?.checkpoint();
		return JSON.parse(text + decoder.decode());
	} catch {
		cancel(reader);
		return undefined;
	} finally {
		reader.releaseLock();
	}
}

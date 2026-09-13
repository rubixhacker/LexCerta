import { abortable } from "../verification/evidence-request.js";

export class HttpBodyUnavailableError extends Error {
	constructor() {
		super("HTTP body unavailable or exceeds its limit");
		this.name = "HttpBodyUnavailableError";
	}
}

export async function readHttpBody(
	response: Response,
	maxBytes: number,
	signal: AbortSignal,
): Promise<Buffer> {
	const reader = response.body?.getReader();
	if (reader === undefined) return Buffer.alloc(0);
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		const declared = response.headers.get("content-length");
		if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes))
			throw new HttpBodyUnavailableError();
		while (true) {
			const chunk = await abortable(() => reader.read(), signal);
			if (chunk.done) return Buffer.concat(chunks, total);
			total += chunk.value.byteLength;
			if (total > maxBytes) throw new HttpBodyUnavailableError();
			chunks.push(chunk.value);
		}
	} finally {
		// Native fetch receives the same signal; a stream's cancellation
		// acknowledgement must not extend the caller's deadline.
		void reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}

export async function readHttpJson(response: Response, maxBytes: number, signal: AbortSignal) {
	return JSON.parse(
		new TextDecoder("utf-8", { fatal: true }).decode(
			await readHttpBody(response, maxBytes, signal),
		),
	) as unknown;
}

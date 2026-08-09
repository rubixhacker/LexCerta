import { z } from "zod";

export const MAX_RESPONSE_BODY_BYTES = 65_536;

function declaredLength(response: Response): number | undefined {
	const value = response.headers.get("content-length");
	if (value === null) return undefined;
	const parsed = z.string().trim().regex(/^\d+$/).safeParse(value);
	if (!parsed.success) return undefined;
	const length = Number(parsed.data);
	return Number.isSafeInteger(length) ? length : undefined;
}

async function cancel(
	source: ReadableStreamDefaultReader<Uint8Array> | ReadableStream<Uint8Array>,
): Promise<void> {
	try {
		await source.cancel();
	} catch {
		return;
	}
}

export async function boundedJsonBody(response: Response): Promise<unknown | undefined> {
	const declared = declaredLength(response);
	const stream = response.body;
	if (declared !== undefined && declared > MAX_RESPONSE_BODY_BYTES) {
		if (stream !== null) await cancel(stream);
		return undefined;
	}
	if (stream === null) return undefined;
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let length = 0;
	let text = "";
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			length += chunk.value.byteLength;
			if (length > MAX_RESPONSE_BODY_BYTES) {
				await cancel(reader);
				return undefined;
			}
			text += decoder.decode(chunk.value, { stream: true });
		}
		return JSON.parse(text + decoder.decode());
	} catch {
		await cancel(reader);
		return undefined;
	} finally {
		reader.releaseLock();
	}
}

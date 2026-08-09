export const MAX_MCP_REQUEST_BODY_BYTES = 65_536;

function declaredLength(request: Request): number | undefined {
	const value = request.headers.get("content-length");
	if (value === null || !/^\d+$/.test(value.trim())) return undefined;
	const length = Number(value);
	return Number.isSafeInteger(length) ? length : undefined;
}

async function cancel(
	source: ReadableStream<Uint8Array> | ReadableStreamDefaultReader<Uint8Array>,
) {
	try {
		await source.cancel();
	} catch {
		// no-excuse-ok: catch
	}
}

function rebuiltRequest(request: Request, bytes: Uint8Array): Request {
	return new Request(request.url, {
		method: request.method,
		headers: new Headers(request.headers),
		body: bytes,
	});
}

export async function boundedMcpRequest(request: Request): Promise<Request | undefined> {
	const body = request.body;
	if (body === null) return request;
	if ((declaredLength(request) ?? 0) > MAX_MCP_REQUEST_BODY_BYTES) {
		await cancel(body);
		return undefined;
	}
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			length += chunk.value.byteLength;
			if (length > MAX_MCP_REQUEST_BODY_BYTES) {
				await cancel(reader);
				return undefined;
			}
			chunks.push(chunk.value);
		}
		const bytes = new Uint8Array(length);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return rebuiltRequest(request, bytes);
	} catch {
		// no-excuse-ok: catch
		await cancel(reader);
		return undefined;
	} finally {
		reader.releaseLock();
	}
}

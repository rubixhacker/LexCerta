import { createServiceHttpServer, type HttpRequestHandler } from "./service-http.js";

export function createOperatorHttpServer(
	handle: HttpRequestHandler,
	options: { readonly build: string; readonly timeoutMs?: number; readonly drainMs?: number },
) {
	return createServiceHttpServer(handle, { ...options, profile: "operator" });
}

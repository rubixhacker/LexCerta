import { createServiceHttpServer, type HttpRequestHandler } from "./service-http.js";

export type PublicRequestHandler = HttpRequestHandler;
export function createPublicHttpServer(
	handle: PublicRequestHandler,
	options: { readonly build: string; readonly timeoutMs?: number; readonly drainMs?: number },
) {
	return createServiceHttpServer(handle, { ...options, profile: "public" });
}

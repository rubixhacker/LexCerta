import {
	type AuthEnvironment,
	authenticateRequest,
	createAuthenticationFailureResponse,
} from "./auth/api-key.js";
import { mcpHandler, protocolBoundaryRejection } from "./mcp.js";

export { ApiKeyLimiter } from "./admission/api-key-limiter.js";

type AdmissionInput = {
	readonly admittedAt: number;
	readonly limits: { readonly minute: number; readonly day: number };
	readonly limitsVersion: number;
};

type AdmissionResult =
	| { readonly kind: "allowed" }
	| { readonly kind: "exhausted"; readonly retryAfterSeconds: number };

interface ApiKeyLimiterStub {
	admit(input: AdmissionInput): Promise<AdmissionResult>;
}

interface ApiKeyLimiterNamespace {
	getByName(name: string): ApiKeyLimiterStub;
}

export type Env = {
	readonly BUILD_ID: string;
	readonly API_KEY_LIMITER: ApiKeyLimiterNamespace;
} & AuthEnvironment;

const worker = {
	async fetch(request: Request, env: Env): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (request.method === "GET" && pathname === "/healthz") {
			return Response.json({ status: "ok", build: env.BUILD_ID });
		}
		if (pathname === "/" && request.method !== "POST") {
			return new Response(null, { headers: { allow: "POST" }, status: 405 });
		}
		if (pathname === "/") {
			const authentication = await authenticateRequest(request, env);
			switch (authentication.kind) {
				case "authenticated": {
					const admission = await admitRequest(env.API_KEY_LIMITER, authentication);
					if (admission.kind === "unavailable") return createAdmissionUnavailableResponse();
					if (admission.kind === "exhausted") {
						return createAdmissionExhaustedResponse(request, admission.retryAfterSeconds);
					}
					const rejection = protocolBoundaryRejection(request);
					if (rejection !== undefined) return rejection;
					return mcpHandler.fetch(request);
				}
				case "unauthorized":
				case "unavailable":
					return createAuthenticationFailureResponse(authentication);
				default: {
					const unreachable: never = authentication;
					return unreachable;
				}
			}
		}
		return new Response(null, { status: 404 });
	},
} satisfies ExportedHandler<Env>;

export default worker;

type AdmissionDecision = AdmissionResult | { readonly kind: "unavailable" };

async function admitRequest(
	namespace: ApiKeyLimiterNamespace,
	authentication: Extract<
		Awaited<ReturnType<typeof authenticateRequest>>,
		{ readonly kind: "authenticated" }
	>,
): Promise<AdmissionDecision> {
	try {
		return await namespace.getByName(authentication.publicId).admit({
			admittedAt: Date.now(),
			limits: authentication.limits,
			limitsVersion: authentication.limitsVersion,
		});
	} catch {
		// no-excuse-ok: catch
		return { kind: "unavailable" };
	}
}

function createAdmissionUnavailableResponse(): Response {
	return new Response('{"error":"Service Unavailable"}', {
		status: 503,
		headers: {
			"cache-control": "no-store",
			"content-type": "application/json",
			"retry-after": "1",
		},
	});
}

async function createAdmissionExhaustedResponse(
	request: Request,
	retryAfterSeconds: number,
): Promise<Response> {
	const id = await recoverRequestId(request);
	const body =
		id === undefined
			? undefined
			: JSON.stringify({
					jsonrpc: "2.0",
					id,
					error: { code: -32029, message: "API key allowance exhausted" },
				});
	return new Response(body, {
		status: 429,
		headers: {
			"cache-control": "no-store",
			...(body === undefined ? {} : { "content-type": "application/json" }),
			"retry-after": String(Math.max(1, Math.ceil(retryAfterSeconds))),
		},
	});
}

const MAX_REQUEST_ID_BYTES = 16_384;
const MAX_STRING_REQUEST_ID_LENGTH = 256;

async function recoverRequestId(request: Request): Promise<string | number | null | undefined> {
	try {
		const body = request.clone().body;
		if (body === null) return undefined;
		const reader = body.getReader();
		const chunks: Uint8Array[] = [];
		let totalBytes = 0;
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			if (chunk.value === undefined) return undefined;
			totalBytes += chunk.value.byteLength;
			if (totalBytes > MAX_REQUEST_ID_BYTES) {
				await reader.cancel();
				return undefined;
			}
			chunks.push(chunk.value);
		}
		const bytes = new Uint8Array(totalBytes);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
		if (typeof parsed !== "object" || parsed === null || !("id" in parsed)) return undefined;
		const id: unknown = parsed.id;
		if (id === null || typeof id === "number") return id;
		return typeof id === "string" && id.length <= MAX_STRING_REQUEST_ID_LENGTH ? id : undefined;
	} catch {
		// no-excuse-ok: catch
		return undefined;
	}
}

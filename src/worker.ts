import {
	type AuthEnvironment,
	authenticateRequest,
	createAuthenticationFailureResponse,
} from "./auth/api-key.js";
import { createCourtListenerApi } from "./courtlistener/api.js";
import type { CourtListenerCoordinatorRpc } from "./courtlistener/coordinator.js";
import { createCourtListenerCitationGateway } from "./courtlistener/gateway.js";
import { createLexCertaMcpHandler, protocolBoundaryRejection } from "./mcp.js";
import { boundedMcpRequest } from "./request-body.js";
import type { CitationVerificationGateway } from "./verification/verify-citation.js";

export { ApiKeyLimiter } from "./admission/api-key-limiter.js";
export { CourtListenerCoordinator } from "./courtlistener/coordinator.js";

type AdmissionInput = {
	readonly admittedAt: number;
	readonly publicId: string;
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

interface CourtListenerCoordinatorNamespace {
	getByName(name: string): CourtListenerCoordinatorRpc;
}

type CourtListenerEnvironment = {
	readonly COURTLISTENER_API_TOKEN?: string;
	readonly COURTLISTENER_COORDINATOR?: CourtListenerCoordinatorNamespace;
	readonly COURTLISTENER_CREDENTIAL_ID?: string;
};

export type Env = {
	readonly BUILD_ID: string;
	readonly API_KEY_LIMITER: ApiKeyLimiterNamespace;
} & AuthEnvironment &
	CourtListenerEnvironment;

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
					const bounded = await boundedMcpRequest(request);
					if (bounded === undefined) return createPayloadTooLargeResponse();
					return createLexCertaMcpHandler(citationGateway(env)).fetch(bounded);
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

function unavailableCitationGateway(): CitationVerificationGateway {
	return {
		lookup: async () => ({ kind: "indeterminate", reason: "upstream_unavailable" }),
	};
}

function citationGateway(env: Env): CitationVerificationGateway {
	const token = env.COURTLISTENER_API_TOKEN;
	const credentialId = env.COURTLISTENER_CREDENTIAL_ID;
	const coordinator = env.COURTLISTENER_COORDINATOR;
	if (
		token === undefined ||
		token.trim().length === 0 ||
		credentialId === undefined ||
		credentialId.length === 0 ||
		coordinator === undefined
	) {
		return unavailableCitationGateway();
	}
	try {
		return createCourtListenerCitationGateway({
			api: createCourtListenerApi({ token, transport: (request) => fetch(request) }),
			coordinator: coordinator.getByName(credentialId),
			now: () => new Date(),
			token: () => crypto.randomUUID(),
		});
	} catch {
		// no-excuse-ok: catch
		return unavailableCitationGateway();
	}
}

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
			publicId: authentication.publicId,
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

function createPayloadTooLargeResponse(): Response {
	return new Response(null, { headers: { "cache-control": "no-store" }, status: 413 });
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
const MAX_REQUEST_ID_CHUNKS = 128;
const MAX_REQUEST_ID_RECOVERY_MILLISECONDS = 100;

async function recoverRequestId(request: Request): Promise<string | number | null | undefined> {
	try {
		const body = request.body;
		if (body === null) return undefined;
		const reader = body.getReader();
		const chunks: Uint8Array[] = [];
		let totalBytes = 0;
		let chunkCount = 0;
		const deadline = Date.now() + MAX_REQUEST_ID_RECOVERY_MILLISECONDS;
		while (true) {
			const chunk = await readChunkBeforeDeadline(reader, deadline);
			if (chunk === "deadline") {
				void reader.cancel().catch(() => undefined);
				return undefined;
			}
			if (chunk.done) break;
			if (chunk.value === undefined) return undefined;
			chunkCount += 1;
			if (chunkCount > MAX_REQUEST_ID_CHUNKS) {
				void reader.cancel().catch(() => undefined);
				return undefined;
			}
			totalBytes += chunk.value.byteLength;
			if (totalBytes > MAX_REQUEST_ID_BYTES) {
				void reader.cancel().catch(() => undefined);
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
		if (id === null) return id;
		if (typeof id === "number") {
			return Number.isFinite(id) && Math.abs(id) <= Number.MAX_SAFE_INTEGER ? id : undefined;
		}
		return typeof id === "string" && id.length <= MAX_STRING_REQUEST_ID_LENGTH ? id : undefined;
	} catch {
		// no-excuse-ok: catch
		return undefined;
	}
}

type TimedReadResult = ReadableStreamReadResult<Uint8Array> | "deadline";

async function readChunkBeforeDeadline(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	deadline: number,
): Promise<TimedReadResult> {
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	try {
		const timeout = new Promise<"deadline">((resolve) => {
			timeoutId = setTimeout(() => resolve("deadline"), Math.max(0, deadline - Date.now()));
		});
		return await Promise.race([reader.read(), timeout]);
	} finally {
		if (timeoutId !== undefined) clearTimeout(timeoutId);
	}
}

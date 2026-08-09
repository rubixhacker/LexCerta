import {
	type ApiKeyPublicId,
	authenticateRequest,
	createAuthenticationFailureResponse,
} from "./auth/api-key.js";
import { createLexCertaMcpHandler, protocolBoundaryRejection } from "./mcp.js";
import { boundedMcpRequest } from "./request-body.js";
import type { TelemetryOutcome } from "./telemetry/contract.js";
import { type ExecutionFacts, createExecutionFactCollector } from "./telemetry/execution-facts.js";
import { createWorkerCitationGateway } from "./verification/worker-citation-gateway.js";
import { createWorkerQuoteGateway } from "./verification/worker-quote-gateway.js";
import type { Env } from "./worker.js";

export type RequestCompletion = {
	readonly boundaryOutcome: TelemetryOutcome | undefined;
	readonly executionFacts: ExecutionFacts | undefined;
	readonly keyIdentifier: ApiKeyPublicId | null;
	readonly response: Response;
};

type CompletionTelemetry = Omit<RequestCompletion, "response">;

const ANONYMOUS_COMPLETION = {
	boundaryOutcome: undefined,
	executionFacts: undefined,
	keyIdentifier: null,
} as const satisfies CompletionTelemetry;

export async function respondToRequest(
	request: Request,
	env: Env,
	pathname: string,
): Promise<RequestCompletion> {
	if (pathname === "/" && request.method !== "POST") {
		return completed(new Response(null, { headers: { allow: "POST" }, status: 405 }));
	}
	if (pathname === "/") {
		const authentication = await authenticateRequest(request, env);
		switch (authentication.kind) {
			case "authenticated": {
				const admission = await admitRequest(env.API_KEY_LIMITER, authentication);
				if (admission.kind === "unavailable") {
					return completed(
						createAdmissionUnavailableResponse(),
						authenticatedCompletion(authentication.publicId, "admission_unavailable"),
					);
				}
				if (admission.kind === "exhausted") {
					return completed(
						await createAdmissionExhaustedResponse(request, admission.retryAfterSeconds),
						authenticatedCompletion(authentication.publicId, "admission_exhausted"),
					);
				}
				const executionFacts = createExecutionFactCollector();
				const rejection = protocolBoundaryRejection(request);
				if (rejection !== undefined) {
					return completed(
						rejection,
						authenticatedCompletion(
							authentication.publicId,
							"protocol_rejected",
							executionFacts.snapshot(),
						),
					);
				}
				const bounded = await boundedMcpRequest(request);
				if (bounded === undefined) {
					return completed(
						createPayloadTooLargeResponse(),
						authenticatedCompletion(
							authentication.publicId,
							"payload_too_large",
							executionFacts.snapshot(),
						),
					);
				}
				const citation = createWorkerCitationGateway({
					coordinator: env.COURTLISTENER_COORDINATOR,
					credentialId: env.COURTLISTENER_CREDENTIAL_ID,
					database: env.DB,
					executionFacts,
					token: env.COURTLISTENER_API_TOKEN,
				});
				const response = await createLexCertaMcpHandler({
					citation,
					quote: createWorkerQuoteGateway({
						coordinator: env.COURTLISTENER_COORDINATOR,
						credentialId: env.COURTLISTENER_CREDENTIAL_ID,
						database: env.DB,
						executionFacts,
						opinionCache: env.OPINION_CACHE,
						token: env.COURTLISTENER_API_TOKEN,
					}),
				}).fetch(bounded);
				return completed(
					response,
					authenticatedCompletion(authentication.publicId, undefined, executionFacts.snapshot()),
				);
			}
			case "unauthorized":
				return completed(createAuthenticationFailureResponse(authentication), {
					...ANONYMOUS_COMPLETION,
					boundaryOutcome: "unauthorized",
				});
			case "unavailable":
				return completed(createAuthenticationFailureResponse(authentication), {
					...ANONYMOUS_COMPLETION,
					boundaryOutcome: "authentication_unavailable",
				});
			default: {
				const unreachable: never = authentication;
				return unreachable;
			}
		}
	}
	return completed(new Response(null, { status: 404 }));
}

type AdmissionDecision =
	| { readonly kind: "allowed" }
	| { readonly kind: "exhausted"; readonly retryAfterSeconds: number }
	| { readonly kind: "unavailable" };

async function admitRequest(
	namespace: Env["API_KEY_LIMITER"],
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

function completed(
	response: Response,
	telemetry: CompletionTelemetry = ANONYMOUS_COMPLETION,
): RequestCompletion {
	return { ...telemetry, response };
}

function authenticatedCompletion(
	keyIdentifier: ApiKeyPublicId,
	boundaryOutcome: TelemetryOutcome | undefined,
	executionFacts: ExecutionFacts | undefined = undefined,
): CompletionTelemetry {
	return { boundaryOutcome, executionFacts, keyIdentifier };
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

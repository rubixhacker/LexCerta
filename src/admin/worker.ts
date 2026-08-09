import { z } from "zod";
import { createApiKeyPublicId } from "../auth/api-key.js";
import { type AccessEnvironment, type AccessIdentity, verifyAccessIdentity } from "./access.js";
import { apiKeyPepper, hmacSha256Hex, secretBytes } from "./credentials.js";
import {
	type ApiKeyLifecycleRecord,
	MAXIMUM_API_KEY_LIMITS,
	changeApiKeyLimits,
	issueApiKey,
	revokeApiKey,
	rotateApiKey,
} from "./key-lifecycle.js";
import { AdminKeyNotFoundError, createAdminKeyStore } from "./key-store.js";
import { AdminKeyRotationConflictError } from "./key-store.js";

const ADMIN_ACTION_SCHEMA = z.enum(["rotate", "revoke", "limits"]);
const API_KEY_LIMITS_SCHEMA = z.object({
	day: z.number().int().positive().max(MAXIMUM_API_KEY_LIMITS.day),
	minute: z.number().int().positive().max(MAXIMUM_API_KEY_LIMITS.minute),
});
const ISSUE_REQUEST_SCHEMA = z.object({
	customerId: z.string().min(1).max(256),
	limits: API_KEY_LIMITS_SCHEMA.optional(),
});
const LIMITS_REQUEST_SCHEMA = API_KEY_LIMITS_SCHEMA;

export type Env = AccessEnvironment & {
	readonly API_KEY_PEPPER?: string;
	readonly DB: D1Database;
	readonly KEY_ENVIRONMENT: string;
};

type Route =
	| { readonly kind: "issue" }
	| { readonly kind: "rotate"; readonly publicId: string }
	| { readonly kind: "revoke"; readonly publicId: string }
	| { readonly kind: "limits"; readonly publicId: string }
	| { readonly kind: "not_found" };

const adminWorker = {
	async fetch(request: Request, env: Env): Promise<Response> {
		const identity = await verifyAccessIdentity(request, env);
		if (identity === null) return unauthorizedResponse();

		const route = parseRoute(request);
		switch (route.kind) {
			case "issue":
				return issue(request, env, identity);
			case "rotate":
				return rotate(route.publicId, env, identity);
			case "revoke":
				return revoke(route.publicId, env, identity);
			case "limits":
				return changeLimits(request, route.publicId, env, identity);
			case "not_found":
				return notFoundResponse();
			default:
				return assertNever(route);
		}
	},
} satisfies ExportedHandler<Env>;

export default adminWorker;

async function issue(request: Request, env: Env, identity: AccessIdentity): Promise<Response> {
	const parsed = await parseJson(request, ISSUE_REQUEST_SCHEMA);
	if (parsed === null) return badRequestResponse();
	const environment = parseKeyEnvironment(env.KEY_ENVIRONMENT);
	const pepper = apiKeyPepper(env.API_KEY_PEPPER);
	if (environment === null || pepper === null) return internalErrorResponse();

	const decision = issueApiKey({
		customerId: parsed.customerId,
		environment,
		issuedAt: new Date(),
		limits: parsed.limits,
		operatorSubject: identity.subject,
		publicId: createApiKeyPublicId(crypto.randomUUID()),
		secret: secretBytes(),
	});
	if (decision.kind !== "issued") return internalErrorResponse();

	try {
		await createAdminKeyStore(env.DB).issue({
			key: decision.key,
			hmacSha256Hex: await hmacSha256Hex(pepper, decision.plaintextCredential.token),
			audit: decision.auditEvent,
		});
		return credentialResponse(decision.key, decision.plaintextCredential.token);
	} catch {
		return internalErrorResponse();
	}
}

async function rotate(publicId: string, env: Env, identity: AccessIdentity): Promise<Response> {
	const key = parsePublicId(publicId);
	const pepper = apiKeyPepper(env.API_KEY_PEPPER);
	if (key === null) return badRequestResponse();
	if (pepper === null) return internalErrorResponse();
	try {
		const store = createAdminKeyStore(env.DB);
		const prior = await store.find(key);
		if (prior === null) return notFoundResponse();
		const decision = rotateApiKey({
			issuedAt: new Date(),
			operatorSubject: identity.subject,
			priorKey: withoutHash(prior),
			publicId: createApiKeyPublicId(crypto.randomUUID()),
			secret: secretBytes(),
		});
		if (decision.kind === "key_not_rotatable") return conflictResponse();
		if (decision.kind !== "rotated") return internalErrorResponse();
		await store.rotate({
			key: decision.newKey,
			priorKey: decision.priorKey,
			hmacSha256Hex: await hmacSha256Hex(pepper, decision.plaintextCredential.token),
			audit: decision.auditEvent,
		});
		return credentialResponse(decision.newKey, decision.plaintextCredential.token);
	} catch (error) {
		return error instanceof AdminKeyRotationConflictError
			? conflictResponse()
			: internalErrorResponse();
	}
}

async function revoke(publicId: string, env: Env, identity: AccessIdentity): Promise<Response> {
	const key = parsePublicId(publicId);
	if (key === null) return badRequestResponse();
	try {
		const store = createAdminKeyStore(env.DB);
		const prior = await store.find(key);
		if (prior === null) return notFoundResponse();
		const decision = revokeApiKey({
			key: withoutHash(prior),
			operatorSubject: identity.subject,
			revokedAt: new Date(),
		});
		await store.revoke({ key: decision.key, audit: decision.auditEvent });
		return Response.json({ key: responseKey(decision.key) }, responseOptions(200));
	} catch (error) {
		if (error instanceof AdminKeyNotFoundError) return notFoundResponse();
		return internalErrorResponse();
	}
}

async function changeLimits(
	request: Request,
	publicId: string,
	env: Env,
	identity: AccessIdentity,
): Promise<Response> {
	const parsed = await parseJson(request, LIMITS_REQUEST_SCHEMA);
	const key = parsePublicId(publicId);
	if (parsed === null || key === null) return badRequestResponse();
	try {
		const store = createAdminKeyStore(env.DB);
		const prior = await store.find(key);
		if (prior === null) return notFoundResponse();
		const decision = changeApiKeyLimits({
			key: withoutHash(prior),
			limits: parsed,
			occurredAt: new Date(),
			operatorSubject: identity.subject,
		});
		if (decision.kind !== "limits_changed") return badRequestResponse();
		await store.changeLimits({ key: decision.key, audit: decision.auditEvent });
		return Response.json({ key: responseKey(decision.key) }, responseOptions(200));
	} catch (error) {
		if (error instanceof AdminKeyNotFoundError) return notFoundResponse();
		return internalErrorResponse();
	}
}

function parseRoute(request: Request): Route {
	const pathname = new URL(request.url).pathname;
	if (request.method === "POST" && pathname === "/v1/keys") return { kind: "issue" };
	const match = /^\/v1\/keys\/([^/]+)\/(rotate|revoke|limits)$/u.exec(pathname);
	if (match === null) return { kind: "not_found" };
	const publicId = match[1];
	const action = ADMIN_ACTION_SCHEMA.safeParse(match[2]);
	if (publicId === undefined || !action.success) return { kind: "not_found" };
	const actionValue = action.data;
	switch (actionValue) {
		case "rotate":
			return request.method === "POST" ? { kind: "rotate", publicId } : { kind: "not_found" };
		case "revoke":
			return request.method === "POST" ? { kind: "revoke", publicId } : { kind: "not_found" };
		case "limits":
			return request.method === "PUT" ? { kind: "limits", publicId } : { kind: "not_found" };
		default:
			return assertNever(actionValue);
	}
}

async function parseJson<T>(request: Request, schema: z.ZodType<T>): Promise<T | null> {
	if (request.headers.get("content-type")?.split(";", 1)[0] !== "application/json") return null;
	try {
		return schema.safeParse(await request.json()).data ?? null;
	} catch {
		return null;
	}
}

function credentialResponse(key: ApiKeyLifecycleRecord, token: string): Response {
	return Response.json({ credential: token, key: responseKey(key) }, responseOptions(201));
}

function responseKey(key: ApiKeyLifecycleRecord): object {
	return {
		customerId: key.customerId,
		environment: key.environment,
		expiresAt: key.expiresAt,
		limits: key.limits,
		publicId: key.publicId,
		rotationOverlapUntil: key.rotationOverlapUntil,
		rotationParentId: key.rotationParentId,
		status: key.status,
	};
}

function responseOptions(status: number): ResponseInit {
	return {
		status,
		headers: {
			"cache-control": "no-store",
			"content-type": "application/json",
			pragma: "no-cache",
			"referrer-policy": "no-referrer",
			"x-content-type-options": "nosniff",
		},
	};
}

function unauthorizedResponse(): Response {
	return new Response('{"error":"Unauthorized"}', responseOptions(401));
}

function badRequestResponse(): Response {
	return new Response('{"error":"Bad Request"}', responseOptions(400));
}

function conflictResponse(): Response {
	return new Response('{"error":"Conflict"}', responseOptions(409));
}

function notFoundResponse(): Response {
	return new Response('{"error":"Not Found"}', responseOptions(404));
}

function internalErrorResponse(): Response {
	return new Response('{"error":"Internal Server Error"}', responseOptions(500));
}

function parseKeyEnvironment(value: string): "production" | "test" | null {
	return value === "production" || value === "test" ? value : null;
}

function parsePublicId(value: string) {
	try {
		return createApiKeyPublicId(value);
	} catch {
		return null;
	}
}

function withoutHash(
	key: ApiKeyLifecycleRecord & { readonly hmacSha256Hex: string },
): ApiKeyLifecycleRecord {
	const { hmacSha256Hex: _, ...record } = key;
	return record;
}

function assertNever(value: never): never {
	throw new Error(`Unexpected variant: ${String(value)}`);
}

import { z } from "zod";

const API_KEY_TOKEN_PATTERN = /^lc_(live|test)_([A-Za-z0-9-]{1,64})_([A-Za-z0-9_-]{43})$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const ZERO_SHA256_HEX = "0".repeat(64);
const API_KEY_PUBLIC_ID_SCHEMA = z.string().min(1).brand("ApiKeyPublicId");
const KEY_ENVIRONMENT_SCHEMA = z.enum(["production", "test"]);

const API_KEY_ROW_SCHEMA = z.object({
	public_id: API_KEY_PUBLIC_ID_SCHEMA,
	environment: KEY_ENVIRONMENT_SCHEMA,
	hmac_sha256_hex: z.string().regex(SHA256_HEX_PATTERN),
	status: z.enum(["active", "revoked"]),
	expires_at: z.string().datetime({ offset: true }),
	revoked_at: z.string().datetime({ offset: true }).nullable(),
	minute_limit: z.number().int().positive(),
	day_limit: z.number().int().positive(),
});

export type KeyEnvironment = z.infer<typeof KEY_ENVIRONMENT_SCHEMA>;

export type ApiKeyRecord = z.infer<typeof API_KEY_ROW_SCHEMA>;
export type ApiKeyPublicId = z.infer<typeof API_KEY_PUBLIC_ID_SCHEMA>;

export function createApiKeyPublicId(value: string): ApiKeyPublicId {
	return API_KEY_PUBLIC_ID_SCHEMA.parse(value);
}

export interface AuthStatement {
	bind(...values: unknown[]): AuthStatement;
	first(): Promise<unknown>;
}

export interface AuthDatabase {
	prepare(sql: string): AuthStatement;
}

export interface AuthEnvironment {
	readonly DB: AuthDatabase;
	readonly API_KEY_PEPPER: string;
	readonly KEY_ENVIRONMENT: string;
}

export type BearerCredential =
	| { readonly kind: "missing" }
	| { readonly kind: "malformed" }
	| { readonly kind: "credential"; readonly token: string };

export type AuthenticationResult =
	| {
			readonly kind: "authenticated";
			readonly publicId: ApiKeyPublicId;
			readonly limits: { readonly minute: number; readonly day: number };
	  }
	| { readonly kind: "unauthorized" }
	| { readonly kind: "unavailable" };

class AuthInfrastructureError extends Error {
	readonly name = "AuthInfrastructureError";
}

export function parseBearerCredential(value: string | null): BearerCredential {
	if (value === null) return { kind: "missing" };
	const match = /^Bearer ([^\s]+)$/iu.exec(value);
	if (match === null) return { kind: "malformed" };
	const token = match[1];
	if (token === undefined) return { kind: "malformed" };
	return { kind: "credential", token };
}

export async function authenticateRequest(
	request: Request,
	env: AuthEnvironment,
	now = new Date(),
): Promise<AuthenticationResult> {
	try {
		const parsedKeyEnvironment = KEY_ENVIRONMENT_SCHEMA.safeParse(env.KEY_ENVIRONMENT);
		if (!parsedKeyEnvironment.success) return { kind: "unavailable" };
		const keyEnvironment = parsedKeyEnvironment.data;

		const credential = parseBearerCredential(request.headers.get("authorization"));
		if (credential.kind !== "credential") return { kind: "unauthorized" };

		const tokenParts = API_KEY_TOKEN_PATTERN.exec(credential.token);
		if (tokenParts === null) return { kind: "unauthorized" };
		const tokenEnvironment = tokenParts[1];
		const publicId = tokenParts[2];
		const expectedTokenEnvironment = keyEnvironment === "production" ? "live" : "test";
		if (tokenEnvironment !== expectedTokenEnvironment || publicId === undefined) {
			return { kind: "unauthorized" };
		}

		const digest = await hmacSha256Hex(env.API_KEY_PEPPER, credential.token);
		const rawRecord = await readApiKeyRecord(env.DB, publicId);
		const record = API_KEY_ROW_SCHEMA.safeParse(rawRecord);
		if (rawRecord !== null && !record.success) {
			throw new AuthInfrastructureError("api key record unavailable", { cause: record.error });
		}
		const expectedHash = record.success ? record.data.hmac_sha256_hex : ZERO_SHA256_HEX;
		const hashMatches = timingSafeHexEqual(digest, expectedHash);
		if (
			!record.success ||
			record.data.environment !== keyEnvironment ||
			!hashMatches ||
			!isUsableRecord(record.data, now)
		) {
			return { kind: "unauthorized" };
		}

		return {
			kind: "authenticated",
			publicId: record.data.public_id,
			limits: { minute: record.data.minute_limit, day: record.data.day_limit },
		};
	} catch (error) {
		if (error instanceof AuthInfrastructureError) return { kind: "unavailable" };
		throw error;
	}
}

export function createAuthenticationFailureResponse(
	result: Extract<AuthenticationResult, { readonly kind: "unauthorized" | "unavailable" }>,
): Response {
	if (result.kind === "unauthorized") {
		return new Response('{"error":"Unauthorized"}', {
			status: 401,
			headers: {
				"content-type": "application/json",
				"cache-control": "no-store",
				"www-authenticate": "Bearer",
			},
		});
	}

	return new Response('{"error":"Service Unavailable"}', {
		status: 503,
		headers: {
			"content-type": "application/json",
			"cache-control": "no-store",
			"retry-after": "1",
		},
	});
}

async function readApiKeyRecord(database: AuthDatabase, publicId: string): Promise<unknown> {
	try {
		return await database
			.prepare(
				"SELECT public_id, environment, hmac_sha256_hex, status, expires_at, revoked_at, minute_limit, day_limit FROM api_key_records WHERE public_id = ?1 LIMIT 1",
			)
			.bind(publicId)
			.first();
	} catch (error) {
		throw new AuthInfrastructureError("api key lookup unavailable", { cause: error });
	}
}

async function hmacSha256Hex(pepper: string, token: string): Promise<string> {
	try {
		if (pepper.length === 0) throw new AuthInfrastructureError("api key verification unavailable");
		const key = await crypto.subtle.importKey(
			"raw",
			new TextEncoder().encode(pepper),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(token));
		return bytesToHex(new Uint8Array(digest));
	} catch (error) {
		throw new AuthInfrastructureError("api key verification unavailable", { cause: error });
	}
}

function isUsableRecord(record: ApiKeyRecord, now: Date): boolean {
	return (
		record.status === "active" &&
		record.revoked_at === null &&
		Date.parse(record.expires_at) > now.getTime()
	);
}

function timingSafeHexEqual(left: string, right: string): boolean {
	const leftBytes = hexToBytes(left);
	const rightBytes = hexToBytes(right);
	const length = Math.max(leftBytes.length, rightBytes.length);
	let difference = leftBytes.length ^ rightBytes.length;
	for (let index = 0; index < length; index += 1) {
		difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
	}
	return difference === 0;
}

function hexToBytes(value: string): Uint8Array {
	const bytes = new Uint8Array(Math.floor(value.length / 2));
	for (let index = 0; index < bytes.length; index += 1) {
		const pair = value.slice(index * 2, index * 2 + 2);
		const parsed = Number.parseInt(pair, 16);
		bytes[index] = Number.isNaN(parsed) ? 0 : parsed;
	}
	return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

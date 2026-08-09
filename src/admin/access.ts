import { z } from "zod";

const ACCESS_ASSERTION_HEADER = "cf-access-jwt-assertion";
const ACCESS_JWT_HEADER_SCHEMA = z.object({ alg: z.literal("RS256"), kid: z.string().min(1) });
const ACCESS_JWT_PAYLOAD_SCHEMA = z.object({
	aud: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
	exp: z.number().finite(),
	iss: z.string().url(),
	nbf: z.number().finite().optional(),
	sub: z.string(),
});
const ACCESS_JWK_SCHEMA = z
	.object({
		alg: z.literal("RS256"),
		e: z.string().min(1),
		kid: z.string().min(1),
		kty: z.literal("RSA"),
		n: z.string().min(1),
	})
	.passthrough();
const ACCESS_JWKS_SCHEMA = z.object({ keys: z.array(ACCESS_JWK_SCHEMA) });

export type AccessEnvironment = {
	readonly ACCESS_AUDIENCE?: string;
	readonly ACCESS_ISSUER?: string;
	readonly ACCESS_JWKS_URL?: string;
	readonly ACCESS_OPERATOR_SUBJECT?: string;
};

export type AccessIdentity = { readonly subject: string };

type AccessConfiguration = {
	readonly audience: string;
	readonly issuer: string;
	readonly jwksUrl: string;
	readonly operatorSubject: string;
};

export async function verifyAccessIdentity(
	request: Request,
	env: AccessEnvironment,
): Promise<AccessIdentity | null> {
	const assertion = request.headers.get(ACCESS_ASSERTION_HEADER);
	const configuration = accessConfiguration(env);
	if (assertion === null || configuration === null) return null;
	const pieces = assertion.split(".");
	const encodedHeader = pieces[0];
	const encodedPayload = pieces[1];
	const encodedSignature = pieces[2];
	if (
		pieces.length !== 3 ||
		encodedHeader === undefined ||
		encodedPayload === undefined ||
		encodedSignature === undefined
	)
		return null;

	const header = parseJwtPart(encodedHeader, ACCESS_JWT_HEADER_SCHEMA);
	const payload = parseJwtPart(encodedPayload, ACCESS_JWT_PAYLOAD_SCHEMA);
	const signature = decodeBase64Url(encodedSignature);
	if (header === null || payload === null || signature === null) return null;
	if (
		payload.iss !== configuration.issuer ||
		!audienceIncludes(payload.aud, configuration.audience)
	)
		return null;
	const now = Math.floor(Date.now() / 1_000);
	if (payload.exp <= now || (payload.nbf !== undefined && payload.nbf > now)) return null;
	if (payload.sub.length === 0 || payload.sub !== configuration.operatorSubject) return null;

	try {
		const jwksResponse = await fetch(configuration.jwksUrl, { signal: AbortSignal.timeout(2_000) });
		if (!jwksResponse.ok) return null;
		const jwks = ACCESS_JWKS_SCHEMA.safeParse(await jwksResponse.json());
		const jwk = jwks.success
			? jwks.data.keys.find((candidate) => candidate.kid === header.kid)
			: undefined;
		if (jwk === undefined) return null;
		const verificationKey = await crypto.subtle.importKey(
			"jwk",
			jwk,
			{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
			false,
			["verify"],
		);
		return (await crypto.subtle.verify(
			"RSASSA-PKCS1-v1_5",
			verificationKey,
			signature,
			new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
		))
			? { subject: payload.sub }
			: null;
	} catch {
		return null;
	}
}

function parseJwtPart<T>(value: string, schema: z.ZodType<T>): T | null {
	const decoded = decodeBase64Url(value);
	if (decoded === null) return null;
	try {
		return schema.safeParse(JSON.parse(new TextDecoder().decode(decoded))).data ?? null;
	} catch {
		return null;
	}
}

function decodeBase64Url(value: string): Uint8Array | null {
	if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
	try {
		const padded = value
			.replaceAll("-", "+")
			.replaceAll("_", "/")
			.padEnd(Math.ceil(value.length / 4) * 4, "=");
		return Uint8Array.from(atob(padded), (character) => character.codePointAt(0) ?? 0);
	} catch {
		return null;
	}
}

function audienceIncludes(audience: string | readonly string[], expected: string): boolean {
	return typeof audience === "string" ? audience === expected : audience.includes(expected);
}

function accessConfiguration(env: AccessEnvironment): AccessConfiguration | null {
	if (
		!isNonEmptyString(env.ACCESS_AUDIENCE) ||
		!isNonEmptyString(env.ACCESS_ISSUER) ||
		!isNonEmptyString(env.ACCESS_JWKS_URL) ||
		!isNonEmptyString(env.ACCESS_OPERATOR_SUBJECT)
	)
		return null;
	return {
		audience: env.ACCESS_AUDIENCE,
		issuer: env.ACCESS_ISSUER,
		jwksUrl: env.ACCESS_JWKS_URL,
		operatorSubject: env.ACCESS_OPERATOR_SUBJECT,
	};
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

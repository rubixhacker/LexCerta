import { createPublicKey } from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import { z } from "zod";
import { abortable, EvidenceRequest } from "../verification/evidence-request.js";
import { readHttpJson } from "./http-body.js";

const CERTIFICATES_URL = "https://www.googleapis.com/oauth2/v1/certs";
const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const Header = z.strictObject({
	alg: z.literal("RS256"),
	kid: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
	typ: z.literal("JWT").optional(),
});
const Claims = z.object({
	iss: z.enum(["https://accounts.google.com", "accounts.google.com"]),
	aud: z.string(),
	sub: z.string().regex(/^[\x21-\x7e]{1,255}$/),
	iat: z.number().int().nonnegative(),
	exp: z.number().int().positive(),
});

export class OperatorIdentityUnavailable extends Error {
	constructor() {
		super("Operator identity verification unavailable");
	}
}

export type OperatorIdentity = (
	token: string | null,
	signal: AbortSignal,
) => Promise<string | null>;

// Only public signing certificates are cached. Audience, subject and strict
// expiry are checked for every request, including requests using a cached key.
export function createOperatorIdentityVerifier(
	audience: string,
	subjects: readonly string[],
	transport: typeof fetch = fetch,
): OperatorIdentity {
	const verifier = new OAuth2Client();
	const allowed = new Set(subjects);
	let certificates: Record<string, string> = Object.create(null);
	let expires = 0;
	let refreshAfter = 0;
	let unavailable = false;
	let refreshing: Promise<void> | undefined;
	async function refresh(signal: AbortSignal) {
		// An unknown kid cannot force a fetch on every request. A newly rotated
		// key can trigger one early refresh per minute; failures use the same bound.
		refreshAfter = performance.now() + 60_000;
		const request = new EvidenceRequest({ signal, timeoutMs: 2000 });
		try {
			const response = await request.run(() =>
				transport(CERTIFICATES_URL, {
					signal: request.signal,
					redirect: "manual",
					headers: { accept: "application/json" },
				}),
			);
			if (response.status !== 200) {
				void response.body?.cancel().catch(() => undefined);
				throw new OperatorIdentityUnavailable();
			}
			const decoded = await readHttpJson(response, 65_536, request.signal);
			const parsed = z
				.record(z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), z.string().max(8192))
				.parse(decoded);
			const entries = Object.entries(parsed);
			if (entries.length < 1 || entries.length > 32) throw new OperatorIdentityUnavailable();
			for (const [, pem] of entries) {
				const key = createPublicKey(pem);
				const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
				if (key.asymmetricKeyType !== "rsa" || bits < 2048 || bits > 4096)
					throw new OperatorIdentityUnavailable();
			}
			const age = Number(response.headers.get("age") ?? "0");
			const maxAge = Number(
				response.headers.get("cache-control")?.match(/(?:^|,)\s*max-age=(\d+)(?:,|$)/i)?.[1] ?? "0",
			);
			if (!Number.isSafeInteger(age) || age < 0 || !Number.isSafeInteger(maxAge))
				throw new OperatorIdentityUnavailable();
			const lifetime = Math.min(3600, Math.max(0, maxAge - age));
			if (!Number.isFinite(lifetime) || lifetime < 1) throw new OperatorIdentityUnavailable();
			request.checkpoint();
			certificates = Object.assign(Object.create(null), parsed);
			expires = performance.now() + lifetime * 1000;
			unavailable = false;
		} catch {
			unavailable = true;
			throw new OperatorIdentityUnavailable();
		} finally {
			request.close();
		}
	}

	return async (token, signal) => {
		if (signal.aborted) throw new OperatorIdentityUnavailable();
		if (
			token === null ||
			token.length > 4096 ||
			!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
		)
			return null;
		let header: z.infer<typeof Header>;
		let claims: z.infer<typeof Claims>;
		try {
			const pieces = token.split(".");
			if (pieces[0] === undefined || pieces[1] === undefined) return null;
			header = Header.parse(
				JSON.parse(
					new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(pieces[0], "base64url")),
				),
			);
			claims = Claims.parse(
				JSON.parse(
					new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(pieces[1], "base64url")),
				),
			);
		} catch {
			return null;
		}
		const current = () => {
			const now = Math.floor(Date.now() / 1000);
			return (
				claims.aud === audience &&
				allowed.has(claims.sub) &&
				claims.exp > now &&
				claims.iat <= now + 30 &&
				claims.exp > claims.iat &&
				claims.exp - claims.iat <= 3600
			);
		};
		if (!current()) return null;
		if (performance.now() >= expires || !Object.hasOwn(certificates, header.kid)) {
			const pending = refreshing;
			if (pending !== undefined) {
				try {
					await abortable(() => pending, signal);
				} catch {
					throw new OperatorIdentityUnavailable();
				}
			} else if (performance.now() >= refreshAfter) {
				refreshing = refresh(signal);
				try {
					await refreshing;
				} finally {
					refreshing = undefined;
				}
			} else if (performance.now() >= expires || unavailable)
				throw new OperatorIdentityUnavailable();
		}
		if (!Object.hasOwn(certificates, header.kid)) return null;
		try {
			// Use the pinned library's public signature verifier with our bounded
			// certificate transport, rather than its retrying certificate fetcher.
			await verifier.verifySignedJwtWithCertsAsync(token, certificates, audience, ISSUERS, 3630);
		} catch {
			return null;
		}
		if (signal.aborted) throw new OperatorIdentityUnavailable();
		return current() ? claims.sub : null;
	};
}

import { z } from "zod";
import { EvidenceRequest } from "../verification/evidence-request.js";
import { readHttpJson } from "./http-body.js";

export type AccessTokenProvider = (signal: AbortSignal) => Promise<string>;
export type MetadataCredentials = { readonly access_token: string; readonly expiry_date: number };
const TOKEN_ENDPOINT =
	"http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const Token = z.object({
	access_token: z
		.string()
		.min(1)
		.max(8192)
		.regex(/^[A-Za-z0-9._~+/-]+=*$/),
	token_type: z.literal("Bearer"),
	expires_in: z.number().int().min(1).max(3600),
});

// Cloud Run's attached identity, obtained on demand. No credential file,
// refresh loop or caller-supplied metadata URL. Tests inject a loopback transport.
export function createMetadataAccessTokenProvider(
	fetcher: typeof fetch = fetch,
): AccessTokenProvider {
	const credentials = createMetadataCredentialsProvider(fetcher);
	return async (signal) => (await credentials(signal)).access_token;
}

export function createMetadataCredentialsProvider(fetcher: typeof fetch = fetch) {
	let cached: { credentials: MetadataCredentials; expiresAt: number } | undefined;
	return async (signal: AbortSignal) => {
		const request = new EvidenceRequest({ signal, timeoutMs: 1000 });
		try {
			return await request.run(async () => {
				if (cached !== undefined && cached.expiresAt > performance.now())
					return { ...cached.credentials };
				const began = performance.now();
				const beganAt = Date.now();
				const response = await fetcher(TOKEN_ENDPOINT, {
					headers: { "Metadata-Flavor": "Google" },
					redirect: "manual",
					signal: request.signal,
				});
				if (response.status !== 200 || response.headers.get("metadata-flavor") !== "Google") {
					void response.body?.cancel().catch(() => undefined);
					throw new Error("Service identity unavailable");
				}
				const value = Token.parse(await readHttpJson(response, 16_384, request.signal));
				request.checkpoint();
				cached = {
					credentials: {
						access_token: value.access_token,
						expiry_date: beganAt + value.expires_in * 1000,
					},
					expiresAt: began + (value.expires_in - 60) * 1000,
				};
				return { ...cached.credentials };
			});
		} catch {
			throw new Error("Service identity unavailable");
		} finally {
			request.close();
		}
	};
}

import { generateKeyPairSync, sign } from "node:crypto";

export const operatorAudience = "https://lexcerta-admin-123456789012.us-central1.run.app";
export const operatorSubject = "123456789012345678901";
export function signedOperatorIdentity() {
	const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const certificates = { "fixture-key": publicKey.export({ format: "pem", type: "spki" }) };
	return {
		certificates,
		token(claims = {}, header = {}) {
			const now = Math.floor(Date.now() / 1000);
			const payload = [
				{ alg: "RS256", kid: "fixture-key", typ: "JWT", ...header },
				{
					iss: "https://accounts.google.com",
					aud: operatorAudience,
					sub: operatorSubject,
					iat: now,
					exp: now + 3600,
					...claims,
				},
			]
				.map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
				.join(".");
			return `${payload}.${sign("RSA-SHA256", Buffer.from(payload), privateKey).toString("base64url")}`;
		},
	};
}

import {
	type ApiKeyRecord,
	type KeyEnvironment,
	createApiKeyPublicId,
} from "../../src/auth/api-key.js";

const LOCAL_TOKEN = `lc_test_local01_${"A".repeat(43)}`;
const LOCAL_PEPPER = "local-test-pepper";
const LOCAL_NOW = new Date("2026-08-08T12:00:00.000Z");

export type LocalFixtureState = "active" | "expired" | "revoked";

export interface LocalAuthFixtureOptions {
	readonly state?: LocalFixtureState;
}

export interface LocalAuthFixture {
	readonly token: string;
	readonly pepper: string;
	readonly now: Date;
	readonly record: ApiKeyRecord;
}

export async function createLocalAuthFixture(
	options: LocalAuthFixtureOptions = {},
): Promise<LocalAuthFixture> {
	const state = options.state ?? "active";
	const record: ApiKeyRecord = {
		public_id: createApiKeyPublicId("local01"),
		environment: "test" satisfies KeyEnvironment,
		hmac_sha256_hex: await hashFixtureToken(LOCAL_PEPPER, LOCAL_TOKEN),
		status: state === "revoked" ? "revoked" : "active",
		expires_at: state === "expired" ? "2026-08-07T12:00:00.000Z" : "2026-08-09T12:00:00.000Z",
		revoked_at: state === "revoked" ? "2026-08-07T12:00:00.000Z" : null,
	};
	return { token: LOCAL_TOKEN, pepper: LOCAL_PEPPER, now: LOCAL_NOW, record };
}

async function hashFixtureToken(pepper: string, token: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(pepper),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(token));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

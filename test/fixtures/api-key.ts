import {
	type ApiKeyRecord,
	type KeyEnvironment,
	createApiKeyPublicId,
} from "../../src/auth/api-key.js";

const LOCAL_PEPPER = "local-test-pepper";
const LOCAL_NOW = new Date("2026-08-08T12:00:00.000Z");

export type LocalFixtureState = "active" | "expired" | "revoked";

export interface LocalAuthFixtureOptions {
	readonly state?: LocalFixtureState;
	readonly publicId?: string;
	readonly limits?: { readonly minute: number; readonly day: number };
	readonly limitsVersion?: number;
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
	const publicId = options.publicId ?? "local01";
	const token = `lc_test_${publicId}_${"A".repeat(43)}`;
	const limits = options.limits ?? { minute: 60, day: 1000 };
	const limitsVersion = options.limitsVersion ?? 1;
	const record: ApiKeyRecord = {
		public_id: createApiKeyPublicId(publicId),
		environment: "test" satisfies KeyEnvironment,
		hmac_sha256_hex: await hashFixtureToken(LOCAL_PEPPER, token),
		status: state === "revoked" ? "revoked" : "active",
		expires_at: state === "expired" ? "2026-08-07T12:00:00.000Z" : "2099-01-01T00:00:00.000Z",
		revoked_at: state === "revoked" ? "2026-08-07T12:00:00.000Z" : null,
		minute_limit: limits.minute,
		day_limit: limits.day,
		limits_version: limitsVersion,
	};
	return { token, pepper: LOCAL_PEPPER, now: LOCAL_NOW, record };
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

import { describe, expect, it } from "vitest";
import { createApiKeyPublicId } from "../auth/api-key.js";
import {
	DEFAULT_API_KEY_LIMITS,
	MAXIMUM_API_KEY_LIMITS,
	changeApiKeyLimits,
	issueApiKey,
	revokeApiKey,
	rotateApiKey,
	type ApiKeyLifecycleRecord,
} from "./key-lifecycle.js";

const ISSUED_AT = new Date("2026-01-01T00:00:00.000Z");
const CUSTOMER_ID = "customer_01";
const OPERATOR_SUBJECT = "access-subject-01";
const PUBLIC_ID = createApiKeyPublicId("key-01");

function secretBytes(): Uint8Array {
	return Uint8Array.from({ length: 32 }, (_, index) => index);
}

describe("issueApiKey", () => {
	it("constructs the supplied 32-byte secret as a one-time production token with the default 90-day expiry", () => {
		const result = issueApiKey({
			customerId: CUSTOMER_ID,
			environment: "production",
			issuedAt: ISSUED_AT,
			operatorSubject: OPERATOR_SUBJECT,
			publicId: PUBLIC_ID,
			secret: secretBytes(),
		});

		expect(result).toMatchObject({
			kind: "issued",
			key: {
				customerId: CUSTOMER_ID,
				environment: "production",
				expiresAt: "2026-04-01T00:00:00.000Z",
				issuedAt: "2026-01-01T00:00:00.000Z",
				limits: DEFAULT_API_KEY_LIMITS,
				publicId: PUBLIC_ID,
				status: "active",
			},
			plaintextCredential: {
				kind: "one_time_plaintext_credential",
				token: "lc_live_key-01_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
			},
		});
	});

	it("rejects a secret that is not exactly 32 bytes", () => {
		const result = issueApiKey({
			customerId: CUSTOMER_ID,
			environment: "test",
			issuedAt: ISSUED_AT,
			operatorSubject: OPERATOR_SUBJECT,
			publicId: PUBLIC_ID,
			secret: new Uint8Array(31),
		});

		expect(result).toEqual({ kind: "invalid_secret_length", receivedByteLength: 31 });
	});

	it("uses the non-production credential prefix", () => {
		const result = issueApiKey({
			customerId: CUSTOMER_ID,
			environment: "test",
			issuedAt: ISSUED_AT,
			operatorSubject: OPERATOR_SUBJECT,
			publicId: PUBLIC_ID,
			secret: secretBytes(),
		});

		expect(result).toMatchObject({
			kind: "issued",
			plaintextCredential: {
				kind: "one_time_plaintext_credential",
				token: "lc_test_key-01_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
			},
		});
	});
});

describe("rotateApiKey", () => {
	it("limits an active prior key to a seven-day overlap while issuing a fresh 90-day token", () => {
		const priorKey = activeKey({ expiresAt: "2026-04-01T00:00:00.000Z" });

		const result = rotateApiKey({
			issuedAt: ISSUED_AT,
			operatorSubject: OPERATOR_SUBJECT,
			priorKey,
			publicId: createApiKeyPublicId("key-02"),
			secret: secretBytes(),
		});

		expect(result).toMatchObject({
			kind: "rotated",
			newKey: {
				expiresAt: "2026-04-01T00:00:00.000Z",
				rotationParentId: PUBLIC_ID,
			},
			priorKey: {
				expiresAt: "2026-01-08T00:00:00.000Z",
				rotationOverlapUntil: "2026-01-08T00:00:00.000Z",
			},
		});
	});

	it("never extends a prior key that expires sooner than the permitted overlap", () => {
		const priorKey = activeKey({ expiresAt: "2026-01-03T00:00:00.000Z" });

		const result = rotateApiKey({
			issuedAt: ISSUED_AT,
			operatorSubject: OPERATOR_SUBJECT,
			priorKey,
			publicId: createApiKeyPublicId("key-02"),
			secret: secretBytes(),
		});

		expect(result).toMatchObject({
			kind: "rotated",
			priorKey: {
				expiresAt: "2026-01-03T00:00:00.000Z",
				rotationOverlapUntil: "2026-01-03T00:00:00.000Z",
			},
		});
	});
});

describe("revokeApiKey", () => {
	it("returns an immediate revocation decision and a credential-free audit event", () => {
		const active = activeKey({ expiresAt: "2026-04-01T00:00:00.000Z" });
		const result = revokeApiKey({
			key: active,
			operatorSubject: OPERATOR_SUBJECT,
			revokedAt: ISSUED_AT,
		});

		expect(result).toMatchObject({
			kind: "revoked",
			key: { revokedAt: "2026-01-01T00:00:00.000Z", status: "revoked" },
			auditEvent: {
				action: "key_revoked",
				actorSubject: OPERATOR_SUBJECT,
				keyPublicId: PUBLIC_ID,
				occurredAt: "2026-01-01T00:00:00.000Z",
			},
		});
		expect(JSON.stringify(result)).not.toContain("lc_");
	});
});

describe("changeApiKeyLimits", () => {
	it("accepts the documented maximum minute and day limits", () => {
		const result = changeApiKeyLimits({
			key: activeKey({ expiresAt: "2026-04-01T00:00:00.000Z" }),
			limits: MAXIMUM_API_KEY_LIMITS,
			occurredAt: ISSUED_AT,
			operatorSubject: OPERATOR_SUBJECT,
		});

		expect(result).toMatchObject({
			kind: "limits_changed",
			key: { limits: { minute: 600, day: 10_000 } },
		});
	});

	it.each([
		{ minute: 601, day: 10_000 },
		{ minute: 600, day: 10_001 },
	])("rejects a limit above the documented maximum %#", (limits) => {
		const result = changeApiKeyLimits({
			key: activeKey({ expiresAt: "2026-04-01T00:00:00.000Z" }),
			limits,
			occurredAt: ISSUED_AT,
			operatorSubject: OPERATOR_SUBJECT,
		});

		expect(result).toEqual({ kind: "invalid_limits" });
	});

	it("accepts positive safe integer limits and emits a sanitized lifecycle audit event", () => {
		const result = changeApiKeyLimits({
			key: activeKey({ expiresAt: "2026-04-01T00:00:00.000Z" }),
			limits: { day: 10_000, minute: 120 },
			occurredAt: ISSUED_AT,
			operatorSubject: OPERATOR_SUBJECT,
		});

		expect(result).toMatchObject({
			kind: "limits_changed",
			key: { limits: { day: 10_000, minute: 120 } },
			auditEvent: { action: "key_limits_changed", keyPublicId: PUBLIC_ID },
		});
	});

	it.each([
		{ day: 1_000, minute: 0 },
		{ day: 0, minute: 60 },
		{ day: 1.5, minute: 60 },
		{ day: Number.MAX_SAFE_INTEGER + 1, minute: 60 },
	])("rejects invalid limits %#", (limits) => {
		const result = changeApiKeyLimits({
			key: activeKey({ expiresAt: "2026-04-01T00:00:00.000Z" }),
			limits,
			occurredAt: ISSUED_AT,
			operatorSubject: OPERATOR_SUBJECT,
		});

		expect(result).toEqual({ kind: "invalid_limits" });
	});
});

function activeKey(overrides: Partial<ApiKeyLifecycleRecord>): ApiKeyLifecycleRecord {
	return {
		customerId: CUSTOMER_ID,
		environment: "test",
		expiresAt: "2026-04-01T00:00:00.000Z",
		issuedAt: "2026-01-01T00:00:00.000Z",
		limits: DEFAULT_API_KEY_LIMITS,
		publicId: PUBLIC_ID,
		revokedAt: null,
		rotationOverlapUntil: null,
		rotationParentId: null,
		status: "active",
		...overrides,
	};
}

import type { ApiKeyPublicId } from "../auth/api-key.js";

const SECRET_BYTE_LENGTH = 32;
const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;
const DEFAULT_KEY_LIFETIME_MILLISECONDS = 90 * DAY_MILLISECONDS;
const MAX_ROTATION_OVERLAP_MILLISECONDS = 7 * DAY_MILLISECONDS;

declare const apiKeyTokenBrand: unique symbol;

export type KeyEnvironment = "production" | "test";
export type ApiKeyToken = string & { readonly [apiKeyTokenBrand]: "ApiKeyToken" };

export type ApiKeyLimits = {
	readonly minute: number;
	readonly day: number;
};

export const DEFAULT_API_KEY_LIMITS = {
	minute: 60,
	day: 1_000,
} as const satisfies ApiKeyLimits;

export const MAXIMUM_API_KEY_LIMITS = {
	minute: 600,
	day: 10_000,
} as const satisfies ApiKeyLimits;

export type ApiKeyLifecycleRecord = {
	readonly customerId: string;
	readonly environment: KeyEnvironment;
	readonly expiresAt: string;
	readonly issuedAt: string;
	readonly limits: ApiKeyLimits;
	readonly publicId: ApiKeyPublicId;
	readonly revokedAt: string | null;
	readonly rotationOverlapUntil: string | null;
	readonly rotationParentId: ApiKeyPublicId | null;
	readonly status: "active" | "revoked";
};

export type OneTimePlaintextCredential = {
	readonly kind: "one_time_plaintext_credential";
	readonly token: ApiKeyToken;
};

export type SanitizedAuditAction =
	| "key_issued"
	| "key_rotated"
	| "key_revoked"
	| "key_limits_changed";

export type SanitizedAuditEvent = {
	readonly action: SanitizedAuditAction;
	readonly actorSubject: string;
	readonly customerId: string;
	readonly keyPublicId: ApiKeyPublicId;
	readonly occurredAt: string;
};

type KeyMaterial = {
	readonly publicId: ApiKeyPublicId;
	readonly secret: Uint8Array;
};

export type IssueApiKeyInput = KeyMaterial & {
	readonly customerId: string;
	readonly environment: KeyEnvironment;
	readonly issuedAt: Date;
	readonly limits?: ApiKeyLimits | undefined;
	readonly operatorSubject: string;
};

export type RotateApiKeyInput = KeyMaterial & {
	readonly issuedAt: Date;
	readonly operatorSubject: string;
	readonly priorKey: ApiKeyLifecycleRecord;
};

export type RevokeApiKeyInput = {
	readonly key: ApiKeyLifecycleRecord;
	readonly operatorSubject: string;
	readonly revokedAt: Date;
};

export type ChangeApiKeyLimitsInput = {
	readonly key: ApiKeyLifecycleRecord;
	readonly limits: ApiKeyLimits;
	readonly occurredAt: Date;
	readonly operatorSubject: string;
};

export type KeyLifecycleError =
	| { readonly kind: "invalid_secret_length"; readonly receivedByteLength: number }
	| { readonly kind: "invalid_limits" }
	| { readonly kind: "key_not_rotatable" };

export type IssueApiKeyResult =
	| {
			readonly kind: "issued";
			readonly auditEvent: SanitizedAuditEvent;
			readonly key: ApiKeyLifecycleRecord;
			readonly plaintextCredential: OneTimePlaintextCredential;
	  }
	| KeyLifecycleError;

export type RotateApiKeyResult =
	| {
			readonly kind: "rotated";
			readonly auditEvent: SanitizedAuditEvent;
			readonly newKey: ApiKeyLifecycleRecord;
			readonly plaintextCredential: OneTimePlaintextCredential;
			readonly priorKey: ApiKeyLifecycleRecord;
	  }
	| KeyLifecycleError;

export type RevokeApiKeyResult = {
	readonly kind: "revoked";
	readonly auditEvent: SanitizedAuditEvent;
	readonly key: ApiKeyLifecycleRecord;
};

export type ChangeApiKeyLimitsResult =
	| {
			readonly kind: "limits_changed";
			readonly auditEvent: SanitizedAuditEvent;
			readonly key: ApiKeyLifecycleRecord;
	  }
	| Extract<KeyLifecycleError, { readonly kind: "invalid_limits" }>;

export function issueApiKey(input: IssueApiKeyInput): IssueApiKeyResult {
	const limits = input.limits ?? DEFAULT_API_KEY_LIMITS;
	if (!areValidLimits(limits)) return { kind: "invalid_limits" };
	const credential = createOneTimePlaintextCredential(input.environment, input);
	if (credential.kind === "invalid_secret_length") return credential;

	const key = createActiveKey({
		customerId: input.customerId,
		environment: input.environment,
		expiresAt: expiryAt(input.issuedAt, DEFAULT_KEY_LIFETIME_MILLISECONDS),
		issuedAt: input.issuedAt.toISOString(),
		limits,
		publicId: input.publicId,
		rotationParentId: null,
	});
	return {
		kind: "issued",
		key,
		plaintextCredential: credential,
		auditEvent: createAuditEvent("key_issued", input.operatorSubject, key, input.issuedAt),
	};
}

export function rotateApiKey(input: RotateApiKeyInput): RotateApiKeyResult {
	if (input.priorKey.status !== "active" || input.priorKey.revokedAt !== null) {
		return { kind: "key_not_rotatable" };
	}
	const credential = createOneTimePlaintextCredential(input.priorKey.environment, input);
	if (credential.kind === "invalid_secret_length") return credential;

	const sevenDaysAfterIssue = expiryAt(input.issuedAt, MAX_ROTATION_OVERLAP_MILLISECONDS);
	const overlapUntil = earliestTimestamp(input.priorKey.expiresAt, sevenDaysAfterIssue);
	const priorKey = {
		...input.priorKey,
		expiresAt: overlapUntil,
		rotationOverlapUntil: overlapUntil,
	};
	const newKey = createActiveKey({
		customerId: input.priorKey.customerId,
		environment: input.priorKey.environment,
		expiresAt: expiryAt(input.issuedAt, DEFAULT_KEY_LIFETIME_MILLISECONDS),
		issuedAt: input.issuedAt.toISOString(),
		limits: input.priorKey.limits,
		publicId: input.publicId,
		rotationParentId: input.priorKey.publicId,
	});
	return {
		kind: "rotated",
		newKey,
		plaintextCredential: credential,
		priorKey,
		auditEvent: createAuditEvent("key_rotated", input.operatorSubject, newKey, input.issuedAt),
	};
}

export function revokeApiKey(input: RevokeApiKeyInput): RevokeApiKeyResult {
	const key = {
		...input.key,
		revokedAt: input.revokedAt.toISOString(),
		status: "revoked" as const,
	};
	return {
		kind: "revoked",
		key,
		auditEvent: createAuditEvent("key_revoked", input.operatorSubject, key, input.revokedAt),
	};
}

export function changeApiKeyLimits(input: ChangeApiKeyLimitsInput): ChangeApiKeyLimitsResult {
	if (!areValidLimits(input.limits)) return { kind: "invalid_limits" };
	const key = { ...input.key, limits: input.limits };
	return {
		kind: "limits_changed",
		key,
		auditEvent: createAuditEvent(
			"key_limits_changed",
			input.operatorSubject,
			key,
			input.occurredAt,
		),
	};
}

function createOneTimePlaintextCredential(
	environment: KeyEnvironment,
	material: KeyMaterial,
):
	| OneTimePlaintextCredential
	| Extract<KeyLifecycleError, { readonly kind: "invalid_secret_length" }> {
	if (material.secret.byteLength !== SECRET_BYTE_LENGTH) {
		return { kind: "invalid_secret_length", receivedByteLength: material.secret.byteLength };
	}
	const prefix = environment === "production" ? "lc_live" : "lc_test";
	const token = `${prefix}_${material.publicId}_${encodeBase64Url(material.secret)}` as ApiKeyToken;
	return { kind: "one_time_plaintext_credential", token };
}

function createActiveKey(input: {
	readonly customerId: string;
	readonly environment: KeyEnvironment;
	readonly expiresAt: string;
	readonly issuedAt: string;
	readonly limits: ApiKeyLimits;
	readonly publicId: ApiKeyPublicId;
	readonly rotationParentId: ApiKeyPublicId | null;
}): ApiKeyLifecycleRecord {
	return {
		...input,
		revokedAt: null,
		rotationOverlapUntil: null,
		status: "active",
	};
}

function createAuditEvent(
	action: SanitizedAuditAction,
	actorSubject: string,
	key: ApiKeyLifecycleRecord,
	occurredAt: Date,
): SanitizedAuditEvent {
	return {
		action,
		actorSubject,
		customerId: key.customerId,
		keyPublicId: key.publicId,
		occurredAt: occurredAt.toISOString(),
	};
}

function areValidLimits(limits: ApiKeyLimits): boolean {
	return (
		Number.isSafeInteger(limits.minute) &&
		limits.minute > 0 &&
		limits.minute <= MAXIMUM_API_KEY_LIMITS.minute &&
		Number.isSafeInteger(limits.day) &&
		limits.day > 0 &&
		limits.day <= MAXIMUM_API_KEY_LIMITS.day
	);
}

function expiryAt(from: Date, durationMilliseconds: number): string {
	return new Date(from.getTime() + durationMilliseconds).toISOString();
}

function earliestTimestamp(left: string, right: string): string {
	return Date.parse(left) <= Date.parse(right) ? left : right;
}

function encodeBase64Url(bytes: Uint8Array): string {
	const base64 = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
	return base64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

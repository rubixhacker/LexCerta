import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import migrationOne from "../migrations/0001_api_key_records.sql?raw";
import migrationTwo from "../migrations/0002_admin_key_lifecycle.sql?raw";
import adminWorker, { type Env as AdminWorkerEnv } from "../src/admin/worker.js";

const PRIVATE_JWK: JsonWebKey = {
	alg: "RS256",
	d: "GkwRKpsM_ctSV23gVU0w_J5-hnnpfDBorMgZtFrqoPEhsG0bSU8fNDkFrimIZfTpcPQhZ5AjEXMiPF33ojdCe5rXL-_tp-mvUe-g1VVTuLbyZiScsOpxf8B7_R8aFlYVykACvjiJWhVLPn_EyKfuIz-wRvYo0CIaGWZAbcNSDP00sw55wJpVGt-XqG8o59z8M8370kTCMoTeLHW_yo__WCZkfiQ2xn7TRl3ZcdL86KdMuWA8lHn9KRl4Z9DNN9Er4RRFMfh4QRX7EynPlVfLp14qVee7CkA0knDV6amyOCBy5lnV-Wayap5HXs4FMxZ4n6CZPiea6Hgx1fgaZfu6yQ",
	e: "AQAB",
	ext: true,
	kty: "RSA",
	n: "uREgDtm8lyX0HhR5NT-pLnwmBIxAqLr0jkEVAEc52UKVj4Ftrrk2umpbG1Et73Wnc4PBXpgQbXhwQVJYmucgh9YunefFKswlinOdxwSNFFjgyaOTBFVXFGkrWsKwf1aONvJn8iARqmL5Bo6D_afOftx71SCxbZYWchC8lNLXuNeftOYKyO2ka6gydMMMOTaViuZGk8dDOAA0mJbKwtdNseIHKLfhngsEZJ0OA4FTVUIyB2bH5D_DmuzAmZKwDovi-ErepLa4JHhihr_eeckFpzWR3sZSkipxaF26DMoHiBaz4zPLTdlMcebG5LVSyEMZFcCzbNKRT0GuyR7z-GQLGw",
	p: "63uV9mmwSt6ol8RFiXl46OfCPGfrhqq_1eSliMcef-xIgUv0fLnPuB_z5zEtDOMtSaHz67cdPOPSkHNh542fwwQRY7y-Hs9gZeiT4eqkwb86d5js16EUOYIe7zX0zt60eSj5U1mo5FE8uJuQ-5MP0Y-oOSoewYyHTnxBbs6o88M",
	q: "yTEFEJcKuKyNLTI_bdsjO-8vwr7byt3Lj1Za5QgAgAa7B3n49eUp3KPa31RKKo2e8ChI3tK-_sLn1xLtnFLy0C9g9jusZAOe7jIHkcGr5pLH4h9qsoNeIwtU7P7XbHwsATlZXz9ll04up1_2K9Ni7Wi68lfmvCUAcIrUTQo5Tck",
	dp: "gq2ttfZG1_WiV76a3ESl3ZInj0AYSz5cgQWG-1WMzm7Aecg94C15YXOR9d2rY3h6vF78rvWKayz-wBzX2xkT7LRINjIay5xHoaYk0v1U-xP1DUO3Q55nS9ay9graVSbvvkEHw8KA4FtYuBXUqledMq1nLHn8YWpr-BkqcqSKy-M",
	dq: "i7eHFOZPg8AQqnpioh-0cELCoDN63373hisqJDNSZZZG_AIwalMipx8DOGSIvNRss8rGEDe6e6FO74UtjYntJbZBV75JEYuSK0iDCS29-vmj5dx7dEzWau_Lomm3oJb62D7DWenk2xZoP8PcaML7yHMaoIF6st3fWEiQ9o9LDEE",
	qi: "bQNwC3gyZnwj7vpnn77cqgj1F-54DDDcI3LUX1-8mMQ9cpQH353dACMO_2U2bspK-hY27a0PvnATs5t1WzifPZNsjcr9sIuDmQrK6hbsWOLI50iT6_RMDCpgFSHcIYRS_VGr6LlmFmtylbYd4Z6L_pnXoZtuwT7dzhbDleGwIYY",
	key_ops: ["sign"],
};
const PUBLIC_JWK = {
	alg: "RS256",
	e: "AQAB",
	ext: true,
	kid: "access-test-key",
	kty: "RSA",
	n: "uREgDtm8lyX0HhR5NT-pLnwmBIxAqLr0jkEVAEc52UKVj4Ftrrk2umpbG1Et73Wnc4PBXpgQbXhwQVJYmucgh9YunefFKswlinOdxwSNFFjgyaOTBFVXFGkrWsKwf1aONvJn8iARqmL5Bo6D_afOftx71SCxbZYWchC8lNLXuNeftOYKyO2ka6gydMMMOTaViuZGk8dDOAA0mJbKwtdNseIHKLfhngsEZJ0OA4FTVUIyB2bH5D_DmuzAmZKwDovi-ErepLa4JHhihr_eeckFpzWR3sZSkipxaF26DMoHiBaz4zPLTdlMcebG5LVSyEMZFcCzbNKRT0GuyR7z-GQLGw",
	key_ops: ["verify"],
} satisfies JsonWebKey & { readonly kid: string };

type CredentialResponse = {
	readonly credential: string;
	readonly key: { readonly publicId: string; readonly status: string };
};

beforeEach(async () => {
	await env.DB.prepare("DROP TABLE IF EXISTS admin_audit_events").run();
	await env.DB.prepare("DROP TABLE IF EXISTS api_key_records").run();
	await env.DB.prepare("DROP TABLE IF EXISTS customers").run();
	await applyMigration(migrationOne);
	await applyMigration(migrationTwo);
	vi.stubGlobal("fetch", async () => Response.json({ keys: [PUBLIC_JWK] }));
});

describe("Access-protected admin Worker", () => {
	it("issues an operator-issued key once with credential-safe response headers and no plaintext persistence", async () => {
		// Given: a signed Access assertion for the allowlisted human operator.
		const request = await operatorRequest("/v1/keys", { customerId: "customer-issue" });

		// When: the operator issues a key through the separate admin Worker.
		const response = await SELF.fetch(request);

		// Then: only this no-store response reveals the plaintext, while D1 contains only its HMAC.
		expect(response.status).toBe(201);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("pragma")).toBe("no-cache");
		expect(response.headers.get("referrer-policy")).toBe("no-referrer");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect(response.headers.get("access-control-allow-origin")).toBeNull();
		const body = (await response.json()) as CredentialResponse;
		expect(body.credential).toMatch(/^lc_test_[A-Za-z0-9-]+_[A-Za-z0-9_-]{43}$/u);
		const stored = await env.DB.prepare(
			"SELECT hmac_sha256_hex FROM api_key_records WHERE public_id = ?1",
		)
			.bind(body.key.publicId)
			.first<{ readonly hmac_sha256_hex: string }>();
		expect(stored?.hmac_sha256_hex).not.toContain(body.credential);
		expect(JSON.stringify(stored)).not.toContain("lc_test_");
	});

	it.each([
		{ label: "empty", pepper: "" },
		{ label: "missing", pepper: undefined },
	])("fails closed before D1 mutation when the API key pepper is $label", async ({ pepper }) => {
		// Given: a real workerd D1 binding and an otherwise-valid verified Access request.
		const request = await operatorRequest("/v1/keys", { customerId: "customer-no-pepper" });

		// When: key issuance runs without its required HMAC pepper.
		const response = await adminWorker.fetch(request, environmentWithPepper(pepper));

		// Then: it returns a generic failure and does not create a credential record.
		expect(response.status).toBe(500);
		const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM api_key_records").first<{
			readonly count: number;
		}>();
		expect(count?.count).toBe(0);
	});

	it("rotates, changes limits, and revokes through operator-only routes", async () => {
		// Given: an existing operator-issued key.
		const issued = await issueKey("customer-lifecycle");

		// When: the operator rotates it, changes the replacement limits, and revokes that replacement.
		const rotatedResponse = await SELF.fetch(
			await operatorRequest(`/v1/keys/${issued.key.publicId}/rotate`),
		);
		const rotated = (await rotatedResponse.json()) as CredentialResponse;
		const limitResponse = await SELF.fetch(
			await operatorRequest(
				`/v1/keys/${rotated.key.publicId}/limits`,
				{ day: 3_000, minute: 90 },
				"PUT",
			),
		);
		const revokeResponse = await SELF.fetch(
			await operatorRequest(`/v1/keys/${rotated.key.publicId}/revoke`),
		);

		// Then: lifecycle state changed without exposing another credential from the non-credential routes.
		expect(rotatedResponse.status).toBe(201);
		expect(rotatedResponse.headers.get("cache-control")).toBe("no-store");
		expect(limitResponse.status).toBe(200);
		expect(await limitResponse.text()).not.toContain(rotated.credential);
		expect(revokeResponse.status).toBe(200);
		const replacement = await env.DB.prepare(
			"SELECT status, minute_limit, day_limit, revoked_at FROM api_key_records WHERE public_id = ?1",
		)
			.bind(rotated.key.publicId)
			.first<{
				readonly day_limit: number;
				readonly minute_limit: number;
				readonly revoked_at: string | null;
				readonly status: string;
			}>();
		expect(replacement).toMatchObject({ day_limit: 3_000, minute_limit: 90, status: "revoked" });
		expect(replacement?.revoked_at).not.toBeNull();
	});

	it.each([
		["missing assertion", undefined],
		["wrong issuer", { iss: "https://other.example.invalid" }],
		["wrong audience", { aud: "other-audience" }],
		["expired assertion", { exp: Math.floor(Date.now() / 1_000) - 1 }],
		["not-yet-valid assertion", { nbf: Math.floor(Date.now() / 1_000) + 60 }],
		["service-token subject", { sub: "" }],
		["unallowlisted subject", { sub: "another-operator" }],
	])("rejects %s before administrative handling", async (_name, claims) => {
		// Given: a request without a valid verified Access identity, including a spoofable email header.
		const request =
			claims === undefined
				? new Request("https://admin.lexcerta.ai/v1/keys", {
						method: "POST",
						headers: { "cf-access-authenticated-user-email": "operator@example.invalid" },
						body: JSON.stringify({ customerId: "customer-rejected" }),
					})
				: await operatorRequest("/v1/keys", { customerId: "customer-rejected" }, "POST", claims);

		// When: it reaches the admin Worker.
		const response = await SELF.fetch(request);

		// Then: it receives the generic Access rejection and no key record is created.
		expect(response.status).toBe(401);
		expect(await response.text()).toBe('{"error":"Unauthorized"}');
		const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM api_key_records").first<{
			readonly count: number;
		}>();
		expect(count?.count).toBe(0);
	});

	it("rejects an assertion with an invalid signature", async () => {
		// Given: a syntactically valid signed assertion whose signature is altered after signing.
		const valid = await signedAccessJwt();
		const tampered = tamperSignature(valid);

		// When: it requests key issuance.
		const response = await SELF.fetch(
			new Request("https://admin.lexcerta.ai/v1/keys", {
				method: "POST",
				headers: { "cf-access-jwt-assertion": tampered, "content-type": "application/json" },
				body: JSON.stringify({ customerId: "customer-tampered" }),
			}),
		);

		// Then: signature verification prevents the spoofed identity from reaching persistence.
		expect(response.status).toBe(401);
		const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM api_key_records").first<{
			readonly count: number;
		}>();
		expect(count?.count).toBe(0);
	});
});

async function issueKey(customerId: string): Promise<CredentialResponse> {
	const response = await SELF.fetch(await operatorRequest("/v1/keys", { customerId }));
	expect(response.status).toBe(201);
	return (await response.json()) as CredentialResponse;
}

async function operatorRequest(
	path: string,
	body?: object,
	method = "POST",
	claims: Readonly<Record<string, string | number>> = {},
): Promise<Request> {
	const headers = new Headers({ "cf-access-jwt-assertion": await signedAccessJwt(claims) });
	if (body !== undefined) headers.set("content-type", "application/json");
	return new Request(`https://admin.lexcerta.ai${path}`, {
		method,
		headers,
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}

async function signedAccessJwt(
	claims: Readonly<Record<string, string | number>> = {},
): Promise<string> {
	const now = Math.floor(Date.now() / 1_000);
	const header = base64Url(JSON.stringify({ alg: "RS256", kid: "access-test-key", typ: "JWT" }));
	const payload = base64Url(
		JSON.stringify({
			aud: "admin-audience-test",
			exp: now + 300,
			iss: "https://access-test.example.invalid",
			sub: "operator-subject-test",
			...claims,
		}),
	);
	const key = await crypto.subtle.importKey(
		"jwk",
		PRIVATE_JWK,
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		key,
		new TextEncoder().encode(`${header}.${payload}`),
	);
	return `${header}.${payload}.${base64Url(signature)}`;
}

async function applyMigration(sql: string): Promise<void> {
	for (const statement of sql
		.split(";")
		.map((value) => value.trim())
		.filter(Boolean)) {
		await env.DB.prepare(statement).run();
	}
}

function base64Url(value: string | ArrayBuffer): string {
	const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
	return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/u, "");
}

function tamperSignature(assertion: string): string {
	const segments = assertion.split(".");
	const signature = segments[2];
	if (segments.length !== 3 || signature === undefined || signature.length < 2) {
		throw new Error("Expected a JWT with a non-empty signature");
	}
	const changedFirstCharacter = signature.startsWith("A") ? "B" : "A";
	return `${segments[0]}.${segments[1]}.${changedFirstCharacter}${signature.slice(1)}`;
}

function environmentWithPepper(pepper: string | undefined): AdminWorkerEnv {
	return {
		ACCESS_AUDIENCE: "admin-audience-test",
		ACCESS_ISSUER: "https://access-test.example.invalid",
		ACCESS_JWKS_URL: "https://access-test.example.invalid/cdn-cgi/access/certs",
		ACCESS_OPERATOR_SUBJECT: "operator-subject-test",
		DB: env.DB,
		KEY_ENVIRONMENT: env.KEY_ENVIRONMENT,
		...(pepper === undefined ? {} : { API_KEY_PEPPER: pepper }),
	};
}

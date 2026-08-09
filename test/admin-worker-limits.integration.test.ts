import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import migrationOne from "../migrations/0001_api_key_records.sql?raw";
import migrationTwo from "../migrations/0002_admin_key_lifecycle.sql?raw";
import migrationThree from "../migrations/0003_api_key_limit_version.sql?raw";

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
	kid: "access-test-key",
	kty: "RSA",
	n: "uREgDtm8lyX0HhR5NT-pLnwmBIxAqLr0jkEVAEc52UKVj4Ftrrk2umpbG1Et73Wnc4PBXpgQbXhwQVJYmucgh9YunefFKswlinOdxwSNFFjgyaOTBFVXFGkrWsKwf1aONvJn8iARqmL5Bo6D_afOftx71SCxbZYWchC8lNLXuNeftOYKyO2ka6gydMMMOTaViuZGk8dDOAA0mJbKwtdNseIHKLfhngsEZJ0OA4FTVUIyB2bH5D_DmuzAmZKwDovi-ErepLa4JHhihr_eeckFpzWR3sZSkipxaF26DMoHiBaz4zPLTdlMcebG5LVSyEMZFcCzbNKRT0GuyR7z-GQLGw",
} satisfies JsonWebKey & { readonly kid: string };

beforeEach(async () => {
	await env.DB.prepare("DROP TABLE IF EXISTS admin_audit_events").run();
	await env.DB.prepare("DROP TABLE IF EXISTS api_key_records").run();
	await env.DB.prepare("DROP TABLE IF EXISTS customers").run();
	await applyMigration(migrationOne);
	await applyMigration(migrationTwo);
	await applyMigration(migrationThree);
	vi.stubGlobal("fetch", async () => Response.json({ keys: [PUBLIC_JWK] }));
});

describe("admin API-key limit boundary", () => {
	it("accepts the shared maximum on issue and limit change", async () => {
		// Given: an authenticated operator request at the service-safe maximum.
		const issued = await SELF.fetch(
			await request("/v1/keys", { customerId: "customer-maximum", limits: maximum() }),
		);

		// When: the operator applies those same maximum limits to the issued key.
		const body = (await issued.json()) as { readonly key: { readonly publicId: string } };
		const changed = await SELF.fetch(
			await request(`/v1/keys/${body.key.publicId}/limits`, maximum(), "PUT"),
		);

		// Then: both routes accept the configured cap.
		expect(issued.status).toBe(201);
		expect(changed.status).toBe(200);
	});

	it("rejects a value above the shared maximum without D1 mutation", async () => {
		// Given: a request with the minute maximum exceeded by one.
		const issued = await SELF.fetch(await request("/v1/keys", { customerId: "customer-existing" }));
		const body = (await issued.json()) as { readonly key: { readonly publicId: string } };

		// When: the operator attempts that excessive change on an existing key.
		for (const limits of overMaximum()) {
			const rejectedIssue = await SELF.fetch(
				await request("/v1/keys", { customerId: "customer-over", limits }),
			);
			const rejectedChange = await SELF.fetch(
				await request(`/v1/keys/${body.key.publicId}/limits`, limits, "PUT"),
			);
			expect(rejectedIssue.status).toBe(400);
			expect(rejectedChange.status).toBe(400);
		}

		// Then: both attempts are bad requests, no excess record exists, and existing limits remain defaults.
		const count = await env.DB.prepare(
			"SELECT COUNT(*) AS count FROM api_key_records WHERE customer_id = ?1",
		)
			.bind("customer-over")
			.first<{ readonly count: number }>();
		const limits = await env.DB.prepare(
			"SELECT minute_limit, day_limit FROM api_key_records WHERE public_id = ?1",
		)
			.bind(body.key.publicId)
			.first<{ readonly day_limit: number; readonly minute_limit: number }>();
		expect(count?.count).toBe(0);
		expect(limits).toEqual({ day_limit: 1_000, minute_limit: 60 });
	});
});

function maximum(): { readonly day: number; readonly minute: number } {
	return { day: 10_000, minute: 600 };
}
function overMaximum(): readonly { readonly day: number; readonly minute: number }[] {
	return [
		{ day: 10_001, minute: 600 },
		{ day: 10_000, minute: 601 },
	];
}
async function request(path: string, body: object, method = "POST"): Promise<Request> {
	const headers = new Headers({
		"cf-access-jwt-assertion": await jwt(),
		"content-type": "application/json",
	});
	return new Request(`https://admin.lexcerta.ai${path}`, {
		method,
		headers,
		body: JSON.stringify(body),
	});
}
async function jwt(): Promise<string> {
	const now = Math.floor(Date.now() / 1_000);
	const header = encoded(JSON.stringify({ alg: "RS256", kid: "access-test-key" }));
	const payload = encoded(
		JSON.stringify({
			aud: "admin-audience-test",
			exp: now + 300,
			iss: "https://access-test.example.invalid",
			sub: "operator-subject-test",
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
	return `${header}.${payload}.${encoded(signature)}`;
}
async function applyMigration(sql: string): Promise<void> {
	for (const statement of sql.match(/\s*CREATE TRIGGER[\s\S]*?END;|[^;]+;/g) ?? [])
		await env.DB.prepare(statement.trim()).run();
}
function encoded(value: string | ArrayBuffer): string {
	const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
	return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/u, "");
}

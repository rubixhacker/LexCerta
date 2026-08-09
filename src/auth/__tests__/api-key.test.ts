import { describe, expect, it } from "vitest";
import { createLocalAuthFixture } from "../../../test/fixtures/api-key.js";
import {
	type AuthDatabase,
	type AuthEnvironment,
	authenticateRequest,
	createAuthenticationFailureResponse,
	parseBearerCredential,
} from "../api-key.js";

class FakeStatement {
	constructor(
		private readonly database: FakeDatabase,
		private readonly sql: string,
		private readonly values: readonly unknown[] = [],
	) {}

	bind(...values: readonly unknown[]): FakeStatement {
		return new FakeStatement(this.database, this.sql, values);
	}

	async first(): Promise<unknown> {
		if (this.database.error !== null) throw this.database.error;
		const publicId = this.values[0];
		if (typeof publicId !== "string") return null;
		const row = this.database.rows.get(publicId);
		return row ?? null;
	}
}

class FakeDatabase implements AuthDatabase {
	readonly rows = new Map<string, Record<string, unknown>>();
	error: Error | null = null;

	prepare(sql: string): FakeStatement {
		return new FakeStatement(this, sql);
	}
}

function environment(database: AuthDatabase, pepper = "local-test-pepper"): AuthEnvironment {
	return { API_KEY_PEPPER: pepper, DB: database, KEY_ENVIRONMENT: "test" };
}

describe("parseBearerCredential", () => {
	it("returns the token for a case-insensitive Bearer scheme", () => {
		const parsed = parseBearerCredential("bEaReR lc_test_public_abcdefghijklmnop");

		expect(parsed).toEqual({ kind: "credential", token: "lc_test_public_abcdefghijklmnop" });
	});

	it("rejects missing, duplicated, and malformed credentials", () => {
		expect(parseBearerCredential(null)).toEqual({ kind: "missing" });
		expect(parseBearerCredential("Basic abc")).toEqual({ kind: "malformed" });
		expect(parseBearerCredential("Bearer one two")).toEqual({ kind: "malformed" });
		expect(parseBearerCredential("Bearer")).toEqual({ kind: "malformed" });
	});
});

describe("authenticateRequest", () => {
	it("authenticates a live fixture without exposing the credential", async () => {
		const fixture = await createLocalAuthFixture();
		const database = new FakeDatabase();
		database.rows.set(fixture.record.public_id, fixture.record);

		const result = await authenticateRequest(
			new Request("https://mcp.lexcerta.ai/", {
				headers: { Authorization: `Bearer ${fixture.token}` },
			}),
			environment(database, fixture.pepper),
			fixture.now,
		);

		expect(result).toEqual({ kind: "authenticated", publicId: fixture.record.public_id });
		expect(JSON.stringify(result)).not.toContain(fixture.token);
	});

	it.each(["missing", "malformed", "expired", "revoked"] as const)(
		"returns an indistinguishable unauthorized result for %s credentials",
		async (state) => {
			const fixture = await createLocalAuthFixture({
				state: state === "expired" || state === "revoked" ? state : "active",
			});
			const database = new FakeDatabase();
			if (state === "expired" || state === "revoked") {
				database.rows.set(fixture.record.public_id, fixture.record);
			}
			const request =
				state === "missing"
					? new Request("https://mcp.lexcerta.ai/")
					: new Request("https://mcp.lexcerta.ai/", {
							headers: {
								Authorization: state === "malformed" ? "Basic abc" : `Bearer ${fixture.token}`,
							},
						});

			const result = await authenticateRequest(
				request,
				environment(database, fixture.pepper),
				fixture.now,
			);

			expect(result).toEqual({ kind: "unauthorized" });
		},
	);

	it("distinguishes D1 failure from invalid credentials", async () => {
		const database = new FakeDatabase();
		database.error = new Error("D1 unavailable");

		const result = await authenticateRequest(
			new Request("https://mcp.lexcerta.ai/", {
				headers: { Authorization: `Bearer lc_test_public_${"A".repeat(43)}` },
			}),
			environment(database),
		);

		expect(result.kind).toBe("unavailable");
	});

	it("fails closed when the HMAC pepper is empty", async () => {
		const fixture = await createLocalAuthFixture();
		const database = new FakeDatabase();
		database.rows.set(fixture.record.public_id, fixture.record);

		const result = await authenticateRequest(
			new Request("https://mcp.lexcerta.ai/", {
				headers: { Authorization: `Bearer ${fixture.token}` },
			}),
			environment(database, ""),
			fixture.now,
		);

		expect(result).toEqual({ kind: "unavailable" });
	});

	it("fails closed when D1 returns a malformed authoritative record", async () => {
		const fixture = await createLocalAuthFixture();
		const database = new FakeDatabase();
		database.rows.set(fixture.record.public_id, {
			...fixture.record,
			hmac_sha256_hex: "not-a-sha256-digest",
		});

		const result = await authenticateRequest(
			new Request("https://mcp.lexcerta.ai/", {
				headers: { Authorization: `Bearer ${fixture.token}` },
			}),
			environment(database, fixture.pepper),
			fixture.now,
		);

		expect(result).toEqual({ kind: "unavailable" });
	});
});

describe("createAuthenticationFailureResponse", () => {
	it("maps unauthorized failures to a generic, credential-free 401", async () => {
		const response = createAuthenticationFailureResponse({ kind: "unauthorized" });

		expect(response.status).toBe(401);
		expect(await response.text()).toBe('{"error":"Unauthorized"}');
		expect(response.headers.get("www-authenticate")).toBe("Bearer");
	});

	it("maps infrastructure failures to retryable 503", async () => {
		const response = createAuthenticationFailureResponse({ kind: "unavailable" });

		expect(response.status).toBe(503);
		expect(response.headers.get("retry-after")).toBe("1");
		expect(await response.text()).toBe('{"error":"Service Unavailable"}');
	});
});

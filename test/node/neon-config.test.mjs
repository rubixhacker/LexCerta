import assert from "node:assert/strict";
import { test } from "node:test";
import { createNeonDatabase } from "../../build/node/neon-database.js";
import { readPublicConfig } from "../../build/node/runtime-config.js";

const environment = {
	LEXCERTA_ENVIRONMENT: "staging",
	GOOGLE_CLOUD_PROJECT: "fixture-project",
	LEXCERTA_DATABASE_HOST: "ep-fixture-123.c-2.us-east-2.aws.neon.tech",
	LEXCERTA_DATABASE_PASSWORD: "synthetic-neon-private-password-32",
	LEXCERTA_BUILD_ID: "0".repeat(40),
	API_KEY_PEPPER: "synthetic-fixture-pepper-value-32bytes",
	COURTLISTENER_CREDENTIAL_ID: "fixture",
	COURTLISTENER_API_TOKEN: "synthetic-fixture-token",
};

test("database configuration rejects URLs, poolers, other regions and missing secrets without echoing them", () => {
	assert.equal(readPublicConfig(environment).database.host, environment.LEXCERTA_DATABASE_HOST);
	for (const override of [
		{ LEXCERTA_DATABASE_HOST: undefined },
		{ LEXCERTA_DATABASE_PASSWORD: undefined },
		{ LEXCERTA_DATABASE_PASSWORD: "short-private-sentinel" },
		{ LEXCERTA_DATABASE_HOST: "ep-fixture-123-pooler.us-east-2.aws.neon.tech" },
		{ LEXCERTA_DATABASE_HOST: "ep-fixture-123.us-east-1.aws.neon.tech" },
		{ LEXCERTA_DATABASE_HOST: "ep-fixture-123.us-east-2.aws.neon.tech.attacker.invalid" },
		{
			LEXCERTA_DATABASE_HOST: "postgres://private:password@ep-fixture-123.us-east-2.aws.neon.tech",
		},
		{ LEXCERTA_DATABASE_HOST: "ep-fixture-123.us-east-2.aws.neon.tech?sslmode=disable" },
		{ LEXCERTA_DATABASE_HOST: "127.0.0.1" },
	])
		assert.throws(() => readPublicConfig({ ...environment, ...override }), {
			message: "Public service configuration is missing or invalid",
		});
});

test("invalid or cancelled database setup never constructs a pool", async () => {
	let calls = 0;
	const createPool = () => {
		calls += 1;
		throw new Error("pool-constructor-private-sentinel");
	};
	const valid = readPublicConfig(environment).database;
	for (const [connection, role, signal] of [
		[{ ...valid, host: "127.0.0.1" }, "public"],
		[valid, "owner"],
		[valid, "public", AbortSignal.abort("private-sentinel")],
	])
		await assert.rejects(createNeonDatabase(connection, role, signal, createPool));
	assert.equal(calls, 0);
});

test("pool credentials bind environment and service purpose without a TLS-overriding URL", async () => {
	for (const env of ["staging", "production"])
		for (const [role, max] of Object.entries({ public: 5, admin: 2, job: 2, migrator: 1 })) {
			let actual;
			await assert.rejects(
				createNeonDatabase(
					{ ...readPublicConfig(environment).database, environment: env },
					role,
					undefined,
					(options) => {
						actual = options;
						throw new Error("pool-constructor-private-sentinel");
					},
				),
				{ message: "Database initialization unavailable" },
			);
			assert.equal(actual.user, `lexcerta_${env}_${role}`);
			assert.equal(actual.database, "lexcerta");
			assert.equal(actual.password, environment.LEXCERTA_DATABASE_PASSWORD);
			assert.equal(actual.connectionString, undefined);
			assert.deepEqual(actual.ssl, { rejectUnauthorized: true, minVersion: "TLSv1.2" });
			assert.equal(actual.enableChannelBinding, true);
			assert.equal(actual.max, max);
		}
});

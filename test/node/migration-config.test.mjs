import assert from "node:assert/strict";
import { test } from "node:test";
import { readMigrationConfig } from "../../build/node/runtime-config.js";
import { databaseRoles } from "../../build/postgres/roles.js";

const values = {
	LEXCERTA_ENVIRONMENT: "staging",
	LEXCERTA_BUILD_ID: "0".repeat(40),
	LEXCERTA_DATABASE_HOST: "ep-fixture-123.us-east-2.aws.neon.tech",
	LEXCERTA_DATABASE_PASSWORD: "synthetic-migration-fixture-password",
};
for (const environment of ["staging", "production"]) {
	test(`migration uses only its ${environment} database identity and build context`, () => {
		const config = readMigrationConfig({ ...values, LEXCERTA_ENVIRONMENT: environment });
		assert.deepEqual(Object.keys(config).sort(), ["build", "database", "environment"]);
		assert.equal(databaseRoles(config.environment).migrator, `lexcerta_${environment}_migrator`);
		assert.equal(new Set(Object.values(databaseRoles(config.environment))).size, 4);
	});
}
test("migration rejects missing or unsafe configuration with a constant error", () => {
	for (const name of Object.keys(values))
		assert.throws(() => readMigrationConfig({ ...values, [name]: undefined }), {
			message: "Migration configuration is missing or invalid",
		});
	for (const host of [
		"127.0.0.1",
		"ep-fixture-123-pooler.us-east-2.aws.neon.tech",
		"postgresql://private-password@ep-fixture-123.us-east-2.aws.neon.tech/lexcerta",
	])
		assert.throws(() => readMigrationConfig({ ...values, LEXCERTA_DATABASE_HOST: host }), {
			message: "Migration configuration is missing or invalid",
		});
});

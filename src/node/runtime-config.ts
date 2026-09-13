import { z } from "zod";

const NeonHost = z
	.string()
	.max(253)
	.regex(/^ep-[a-z0-9]+(?:-[a-z0-9]+)*\.(?:c-[0-9]+\.)?us-east-2\.aws\.neon\.tech$/)
	.refine((value) => !value.split(".")[0]?.endsWith("-pooler"));
const DatabasePassword = z
	.string()
	.min(32)
	.max(1024)
	.regex(/^[\x21-\x7e]+$/);
export const NeonConnection = z.object({
	environment: z.enum(["staging", "production"]),
	host: NeonHost,
	password: DatabasePassword,
});

const CommonEnvironment = z.object({
	LEXCERTA_ENVIRONMENT: z.enum(["staging", "production"]),
	GOOGLE_CLOUD_PROJECT: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/),
	LEXCERTA_BUILD_ID: z.string().regex(/^[a-f0-9]{40}$/),
	API_KEY_PEPPER: z.string().min(32).max(1024),
	LEXCERTA_DATABASE_HOST: NeonHost,
	LEXCERTA_DATABASE_PASSWORD: DatabasePassword,
	PORT: z
		.string()
		.regex(/^\d{1,5}$/)
		.default("8080")
		.transform(Number)
		.pipe(z.number().int().min(1).max(65535)),
});
const Environment = CommonEnvironment.extend({
	COURTLISTENER_CREDENTIAL_ID: z
		.string()
		.min(1)
		.max(128)
		.regex(/^[A-Za-z0-9_-]+$/),
	COURTLISTENER_API_TOKEN: z
		.string()
		.min(1)
		.max(1024)
		.regex(/^[A-Za-z0-9._~+/-]+=*$/),
});

const JobEnvironment = CommonEnvironment.omit({ API_KEY_PEPPER: true, PORT: true });
const MigrationEnvironment = JobEnvironment.omit({ GOOGLE_CLOUD_PROJECT: true });
export function readMigrationConfig(environment: NodeJS.ProcessEnv) {
	const parsed = MigrationEnvironment.safeParse(environment);
	if (!parsed.success) throw new Error("Migration configuration is missing or invalid");
	const value = parsed.data;
	return {
		environment: value.LEXCERTA_ENVIRONMENT,
		build: value.LEXCERTA_BUILD_ID,
		database: {
			environment: value.LEXCERTA_ENVIRONMENT,
			host: value.LEXCERTA_DATABASE_HOST,
			password: value.LEXCERTA_DATABASE_PASSWORD,
		},
	};
}

export function readJobConfig(environment: NodeJS.ProcessEnv) {
	const parsed = JobEnvironment.safeParse(environment);
	if (!parsed.success) throw new Error("Maintenance configuration is missing or invalid");
	const value = parsed.data;
	return {
		environment: value.LEXCERTA_ENVIRONMENT,
		project: value.GOOGLE_CLOUD_PROJECT,
		build: value.LEXCERTA_BUILD_ID,
		database: {
			environment: value.LEXCERTA_ENVIRONMENT,
			host: value.LEXCERTA_DATABASE_HOST,
			password: value.LEXCERTA_DATABASE_PASSWORD,
		},
		sourceBucket: `${value.GOOGLE_CLOUD_PROJECT}-lexcerta-sources`,
	};
}

export const OperatorAudience = z
	.string()
	.max(253)
	.regex(
		/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?){0,2}\.run\.app$/,
	);
export const PilotCustomerId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const OperatorEnvironment = CommonEnvironment.extend({
	LEXCERTA_OPERATOR_AUDIENCE: OperatorAudience,
	LEXCERTA_OPERATOR_SUBJECTS: z
		.string()
		.transform((value) => value.split(","))
		.pipe(
			z
				.array(z.string().regex(/^[\x21-\x2b\x2d-\x7e]{1,255}$/))
				.min(1)
				.max(10),
		),
	LEXCERTA_PILOT_CUSTOMERS: z
		.string()
		.transform((value) => value.split(","))
		.pipe(z.array(PilotCustomerId).min(1).max(3)),
});

export function readOperatorConfig(environment: NodeJS.ProcessEnv) {
	const parsed = OperatorEnvironment.safeParse(environment);
	if (!parsed.success) throw new Error("Operator service configuration is missing or invalid");
	const value = parsed.data;
	return {
		environment: value.LEXCERTA_ENVIRONMENT,
		keyEnvironment:
			value.LEXCERTA_ENVIRONMENT === "production" ? ("production" as const) : ("test" as const),
		project: value.GOOGLE_CLOUD_PROJECT,
		database: {
			environment: value.LEXCERTA_ENVIRONMENT,
			host: value.LEXCERTA_DATABASE_HOST,
			password: value.LEXCERTA_DATABASE_PASSWORD,
		},
		build: value.LEXCERTA_BUILD_ID,
		pepper: value.API_KEY_PEPPER,
		port: value.PORT,
		audience: value.LEXCERTA_OPERATOR_AUDIENCE,
		subjects: value.LEXCERTA_OPERATOR_SUBJECTS,
		customers: value.LEXCERTA_PILOT_CUSTOMERS,
	};
}

export function readPublicConfig(environment: NodeJS.ProcessEnv) {
	const parsed = Environment.safeParse(environment);
	if (!parsed.success) throw new Error("Public service configuration is missing or invalid");
	const value = parsed.data;
	return {
		environment: value.LEXCERTA_ENVIRONMENT,
		keyEnvironment:
			value.LEXCERTA_ENVIRONMENT === "production" ? ("production" as const) : ("test" as const),
		project: value.GOOGLE_CLOUD_PROJECT,
		database: {
			environment: value.LEXCERTA_ENVIRONMENT,
			host: value.LEXCERTA_DATABASE_HOST,
			password: value.LEXCERTA_DATABASE_PASSWORD,
		},
		build: value.LEXCERTA_BUILD_ID,
		pepper: value.API_KEY_PEPPER,
		credentialId: value.COURTLISTENER_CREDENTIAL_ID,
		upstreamToken: value.COURTLISTENER_API_TOKEN,
		port: value.PORT,
		sourceBucket: `${value.GOOGLE_CLOUD_PROJECT}-lexcerta-sources`,
	};
}

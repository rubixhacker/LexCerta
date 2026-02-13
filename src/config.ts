import { z } from "zod";
import { logger } from "./logger.js";

export const ConfigSchema = z.object({
	COURTLISTENER_API_KEY: z.string().min(1, "COURTLISTENER_API_KEY is required"),
	PORT: z.coerce.number().default(3000),
	NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
	const result = ConfigSchema.safeParse(process.env);
	if (!result.success) {
		logger.error("Invalid configuration:");
		logger.error(result.error.format());
		process.exit(1);
	}
	return result.data;
}

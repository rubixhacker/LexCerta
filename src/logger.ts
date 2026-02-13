export const logger = {
	info: (...args: unknown[]) => console.error("[INFO]", ...args),
	warn: (...args: unknown[]) => console.error("[WARN]", ...args),
	error: (...args: unknown[]) => console.error("[ERROR]", ...args),
	debug: (...args: unknown[]) => console.error("[DEBUG]", ...args),
};

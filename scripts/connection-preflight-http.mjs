import { z } from "zod";

const endpointSchema = z.url().refine((value) => {
	const url = new URL(value);
	return (
		!url.username &&
		!url.password &&
		!url.search &&
		!url.hash &&
		(url.protocol === "https:" ||
			(url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)))
	);
});

export const optionsSchema = z
	.object({
		endpoint: endpointSchema,
		token: z
			.string()
			.min(1)
			.max(4096)
			.regex(/^[\x21-\x7e]+$/),
		timeoutMs: z.number().int().min(1).max(10000).default(5000),
	})
	.strict();

export async function requestJson(url, init, timeoutMs) {
	try {
		const response = await fetch(url, {
			...init,
			redirect: "manual",
			signal: AbortSignal.timeout(timeoutMs),
		});
		const facts = {
			httpStatus: response.status,
			challenge: response.headers.get("www-authenticate"),
		};
		if (!response.ok) {
			await response.body?.cancel();
			return { ...facts, status: "http_error" };
		}
		if (
			response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
			"application/json"
		) {
			await response.body?.cancel();
			return { ...facts, status: "invalid_json" };
		}
		const reader = response.body?.getReader();
		if (!reader) return { ...facts, status: "invalid_json" };
		const chunks = [];
		let size = 0;
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			size += chunk.value.byteLength;
			if (size > 65536) {
				await reader.cancel();
				return { ...facts, status: "response_too_large" };
			}
			chunks.push(chunk.value);
		}
		try {
			return {
				...facts,
				status: "received",
				body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
			};
		} catch (error) {
			if (!(error instanceof SyntaxError)) throw error;
			return { ...facts, status: "invalid_json" };
		}
	} catch (error) {
		if (error instanceof Error) {
			return {
				status: ["TimeoutError", "AbortError"].includes(error.name) ? "timeout" : "network_error",
			};
		}
		throw error;
	}
}

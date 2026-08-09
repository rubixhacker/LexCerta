export function apiKeyPepper(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

export async function hmacSha256Hex(pepper: string, token: string): Promise<string> {
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(pepper),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const bytes = new Uint8Array(
		await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(token)),
	);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function secretBytes(): Uint8Array {
	return crypto.getRandomValues(new Uint8Array(32));
}

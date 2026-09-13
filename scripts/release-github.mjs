export const RELEASE_REPOSITORY = "rubixhacker/LexCerta";

export function repositoryApiUrl(path) {
	if (
		!/^(?:branches\/main|environments\/production(?:\/deployment-branch-policies\?per_page=100)?|actions\/runs\/[1-9][0-9]{0,15}(?:\/artifacts\?per_page=100)?|actions\/artifacts\/[1-9][0-9]{0,15}(?:\/zip)?)$/.test(
			path,
		)
	)
		throw new Error("GitHub release evidence unavailable");
	return `https://api.github.com/repos/${RELEASE_REPOSITORY}/${path}`;
}

export function githubHeaders(token) {
	if (token !== undefined && !/^[\x21-\x7e]{1,4096}$/.test(token))
		throw new Error("GitHub release evidence unavailable");
	return {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2026-03-10",
		...(token ? { Authorization: `Bearer ${token}` } : {}),
	};
}

export async function readGitHubReleaseJson(path, { token, request = fetch, signal } = {}) {
	const timeout = AbortSignal.timeout(10_000);
	const abort = signal ? AbortSignal.any([timeout, signal]) : timeout;
	let reader;
	try {
		abort.throwIfAborted();
		const response = await request(repositoryApiUrl(path), {
			method: "GET",
			redirect: "error",
			signal: abort,
			headers: githubHeaders(token),
		});
		if (response.status === 404) {
			void response.body?.cancel().catch(() => undefined);
			return null;
		}
		if (!response.ok) {
			void response.body?.cancel().catch(() => undefined);
			throw new Error();
		}
		reader = response.body?.getReader();
		if (!reader) throw new Error();
		const chunks = [];
		let bytes = 0;
		for (;;) {
			abort.throwIfAborted();
			const { value, done } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > 262_144) throw new Error();
			chunks.push(value);
		}
		abort.throwIfAborted();
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new Error("GitHub release evidence unavailable");
	} finally {
		void reader?.cancel().catch(() => undefined);
	}
}

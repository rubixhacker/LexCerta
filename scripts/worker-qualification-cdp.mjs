export async function connectCdp(url, signal) {
	const socket = new WebSocket(url);
	await new Promise((resolve, reject) => {
		let settled = false;
		const cleanup = () => {
			socket.removeEventListener("open", onOpen);
			socket.removeEventListener("error", onError);
			signal?.removeEventListener("abort", onAbort);
		};
		const finish = (completion, value) => {
			if (settled) return;
			settled = true;
			cleanup();
			completion(value);
		};
		const onOpen = () => finish(resolve);
		const onError = (event) => finish(reject, event);
		const onAbort = () => {
			const reason = signal?.reason ?? new Error("CDP connection aborted");
			finish(reject, reason);
			socket.close();
		};
		socket.addEventListener("open", onOpen, { once: true });
		socket.addEventListener("error", onError, { once: true });
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();
	});
	let sequence = 0;
	const pending = new Map();
	socket.addEventListener("message", (event) => {
		const message = JSON.parse(event.data);
		const call = pending.get(message.id);
		if (call === undefined) return;
		pending.delete(message.id);
		if (message.error === undefined) call.resolve(message.result);
		else call.reject(new TypeError(JSON.stringify(message.error)));
	});
	return {
		call: (method, params = {}) =>
			new Promise((resolve, reject) => {
				const id = ++sequence;
				pending.set(id, { reject, resolve });
				socket.send(JSON.stringify({ id, method, params }));
			}),
		close: () => {
			for (const call of pending.values()) call.reject(new TypeError("CDP socket closed"));
			pending.clear();
			socket.close();
		},
	};
}

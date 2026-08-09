export async function connectCdp(url) {
	const socket = new WebSocket(url);
	await new Promise((resolve, reject) => {
		socket.addEventListener("open", resolve, { once: true });
		socket.addEventListener("error", reject, { once: true });
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

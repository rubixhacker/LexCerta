import assert from "node:assert/strict";
import test from "node:test";
import { connectCdp } from "./worker-qualification-cdp.mjs";

test("rejects and clears pending CDP calls before closing the socket", async () => {
	const originalWebSocket = globalThis.WebSocket;
	globalThis.WebSocket = FakeSocket;
	try {
		const client = await connectCdp("ws://qualification.invalid");
		const socket = FakeSocket.instance;
		const pending = client.call("Runtime.getHeapUsage");
		client.close();
		await assert.rejects(pending, /CDP socket closed/);
		assert.equal(socket.closed, true);
		assert.equal(socket.listeners.get("message")?.size, 1);
	} finally {
		globalThis.WebSocket = originalWebSocket;
	}
});

class FakeSocket {
	static instance;
	closed = false;
	listeners = new Map();
	constructor() {
		FakeSocket.instance = this;
		queueMicrotask(() => this.emit("open"));
	}
	addEventListener(name, listener) {
		const listeners = this.listeners.get(name) ?? new Set();
		listeners.add(listener);
		this.listeners.set(name, listeners);
	}
	close() {
		this.closed = true;
	}
	emit(name) {
		for (const listener of this.listeners.get(name) ?? []) listener({});
	}
	send() {}
}

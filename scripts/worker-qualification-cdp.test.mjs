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

test("aborts and closes a CDP handshake that never opens", async () => {
	const originalWebSocket = globalThis.WebSocket;
	globalThis.WebSocket = NeverOpeningSocket;
	const controller = new AbortController();
	try {
		const pending = connectCdp("ws://qualification.invalid", controller.signal);
		const socket = NeverOpeningSocket.instance;
		controller.abort(new TypeError("worker qualification exceeded harness deadline"));
		await assert.rejects(pending, /exceeded harness deadline/);
		assert.equal(socket.closed, true);
		assert.equal(socket.listeners.get("open")?.size ?? 0, 0);
		assert.equal(socket.listeners.get("error")?.size ?? 0, 0);
		socket.emit("open");
		socket.emit("error");
		assert.equal(socket.listeners.get("open")?.size ?? 0, 0);
		assert.equal(socket.listeners.get("error")?.size ?? 0, 0);
	} finally {
		globalThis.WebSocket = originalWebSocket;
	}
});

class FakeSocket {
	static instance;
	closed = false;
	listeners = new Map();
	constructor(_url, open = true) {
		FakeSocket.instance = this;
		if (open) queueMicrotask(() => this.emit("open"));
	}
	addEventListener(name, listener) {
		const listeners = this.listeners.get(name) ?? new Set();
		listeners.add(listener);
		this.listeners.set(name, listeners);
	}
	removeEventListener(name, listener) {
		this.listeners.get(name)?.delete(listener);
	}
	close() {
		this.closed = true;
	}
	emit(name) {
		for (const listener of this.listeners.get(name) ?? []) listener({});
	}
	send() {}
}

class NeverOpeningSocket extends FakeSocket {
	constructor(url) {
		super(url, false);
		NeverOpeningSocket.instance = this;
	}
}

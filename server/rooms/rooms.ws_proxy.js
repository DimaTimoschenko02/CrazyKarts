import { WebSocket, WebSocketServer } from "ws";
import logger from "../shared/logger.js";

const ROOM_PATH = /^\/ws\/([A-Za-z0-9]+)\/?$/;

export function attachWsProxy(httpServer, repo) {
	const wss = new WebSocketServer({ noServer: true });

	httpServer.on("upgrade", (req, socket, head) => {
		const url = new URL(req.url, "http://placeholder");
		const match = url.pathname.match(ROOM_PATH);
		if (!match) {
			rejectUpgrade(socket, 404, "no_room_in_path");
			return;
		}
		const code = match[1].toUpperCase();
		const room = repo.getByCode(code);
		if (!room || room.state === "CLEANUP") {
			rejectUpgrade(socket, 404, `unknown_room:${code}`);
			return;
		}
		const target = `ws://127.0.0.1:${room.port}/`;
		const subprotocols = req.headers["sec-websocket-protocol"];

		wss.handleUpgrade(req, socket, head, (clientWs) => {
			let backendOpen = false;
			let closed = false;
			const queued = [];

			const backendOpts = {};
			if (subprotocols) {
				backendOpts.protocol = subprotocols.split(",").map((s) => s.trim());
			}
			const backend = new WebSocket(target, backendOpts.protocol, {
				perMessageDeflate: false,
			});

			function closeBoth(reason) {
				if (closed) return;
				closed = true;
				try { clientWs.close(); } catch (_) {}
				try { backend.close(); } catch (_) {}
				logger.debug(`[ws-proxy] closed code=${code} reason=${reason}`);
			}

			clientWs.on("message", (data, isBinary) => {
				if (backendOpen) backend.send(data, { binary: isBinary });
				else queued.push([data, isBinary]);
			});
			clientWs.on("close", () => closeBoth("client_closed"));
			clientWs.on("error", (err) => {
				logger.warn(`[ws-proxy] client err code=${code} ${err?.message}`);
				closeBoth("client_error");
			});

			backend.on("open", () => {
				backendOpen = true;
				for (const [d, b] of queued) backend.send(d, { binary: b });
				queued.length = 0;
				logger.debug(`[ws-proxy] connected code=${code} target=${target}`);
			});
			backend.on("message", (data, isBinary) => {
				if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data, { binary: isBinary });
			});
			backend.on("close", () => closeBoth("backend_closed"));
			backend.on("error", (err) => {
				logger.warn(`[ws-proxy] backend err code=${code} ${err?.message}`);
				closeBoth("backend_error");
			});
		});
	});
}

function rejectUpgrade(socket, status, reason) {
	const text = String(status);
	socket.write(`HTTP/1.1 ${text} ${reason}\r\nConnection: close\r\n\r\n`);
	socket.destroy();
}

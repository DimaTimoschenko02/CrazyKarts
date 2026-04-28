import express from "express";
import config from "./config.js";
import logger from "./shared/logger.js";
import { corsMiddleware } from "./shared/cors.js";
import { errorHandler } from "./shared/errors.js";
import healthRouter from "./health/health.controller.js";
import profilesRouter from "./profiles/profiles.controller.js";
import roomsRouter, { roomsRepo } from "./rooms/rooms.controller.js";
import { attachWsProxy } from "./rooms/rooms.ws_proxy.js";
import matchesRouter from "./matches/matches.controller.js";

const app = express();

app.use(corsMiddleware());
app.use(express.json({ limit: "1mb" }));

app.use(healthRouter);
app.use(profilesRouter);
app.use(roomsRouter);
app.use(matchesRouter);

app.use(errorHandler);

const server = app.listen(config.masterPort, config.masterHost, () => {
	logger.info("Master server listening", {
		host: config.masterHost,
		port: config.masterPort,
		public_base_url: config.publicBaseUrl,
		dev_mode: config.devMode,
	});
});

attachWsProxy(server, roomsRepo);

function shutdown(signal) {
	logger.info(`Received ${signal}, shutting down`);
	server.close(() => {
		logger.info("HTTP server closed");
		process.exit(0);
	});
	setTimeout(() => {
		logger.warn("Forced shutdown after 5s");
		process.exit(1);
	}, 5000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

import { Router } from "express";
import db from "../db/index.js";
import config from "../config.js";

const router = Router();

router.get("/api/health", (_req, res) => {
	const dbVersion = db.pragma("user_version", { simple: true });
	res.json({
		status: "ok",
		uptime_s: Math.round(process.uptime()),
		dev_mode: config.devMode,
		db_version: dbVersion,
		master_port: config.masterPort,
	});
});

export default router;

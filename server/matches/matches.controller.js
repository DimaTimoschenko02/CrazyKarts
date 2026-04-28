import { Router } from "express";
import db from "../db/index.js";
import { internalAuth } from "../internal/internal.middleware.js";
import { createMatchesRepository } from "./matches.repository.js";
import { createMatchesService } from "./matches.service.js";
import { validateMatchSubmit } from "./matches.dto.js";

const repo = createMatchesRepository(db);
const service = createMatchesService({ db, repo });

const router = Router();

router.post("/api/internal/match/submit", internalAuth, (req, res) => {
	const payload = validateMatchSubmit(req.body);
	const result = service.submit(payload);
	res.status(202).json({ accepted: true, ...result });
});

export { service as matchesService, repo as matchesRepo };
export default router;

import { Router } from "express";
import db from "../db/index.js";
import { createProfilesRepository } from "./profiles.repository.js";
import { createProfilesService } from "./profiles.service.js";
import { validateAuthToken, validateNickname } from "./profiles.dto.js";

export function createProfilesRouter(service) {
	const router = Router();

	router.get("/api/profile/check", (req, res) => {
		const { display, lower } = validateNickname(req.query.nick);
		res.json(service.check({ display, lower }));
	});

	router.post("/api/profile/register", (req, res) => {
		const { display, lower } = validateNickname(req.body?.nickname);
		const result = service.register({ display, lower });
		res.status(201).json(result);
	});

	router.post("/api/profile/auth", (req, res) => {
		const token = validateAuthToken(req.body?.auth_token);
		res.json(service.authByToken(token));
	});

	router.post("/api/profile/claim", (req, res) => {
		const { display, lower } = validateNickname(req.body?.nickname);
		const result = service.claim({ display, lower });
		res.json(result);
	});

	return router;
}

const repo = createProfilesRepository(db);
const service = createProfilesService({ repo });

export default createProfilesRouter(service);

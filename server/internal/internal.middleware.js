import config from "../config.js";
import { UnauthorizedError } from "../shared/errors.js";

export function internalAuth(req, _res, next) {
	const header = req.headers.authorization || "";
	if (!header.startsWith("Bearer ")) {
		return next(new UnauthorizedError("missing bearer token"));
	}
	const token = header.slice(7).trim();
	if (token === "" || token !== config.internalToken) {
		return next(new UnauthorizedError("invalid internal token"));
	}
	next();
}

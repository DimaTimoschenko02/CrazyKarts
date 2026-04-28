import corsLib from "cors";
import config from "../config.js";

export function corsMiddleware() {
	return corsLib({
		origin: (origin, cb) => {
			if (!origin) return cb(null, true);
			if (config.corsOrigins.includes(origin)) return cb(null, true);
			return cb(new Error(`CORS: origin not allowed: ${origin}`));
		},
		credentials: false,
		methods: ["GET", "POST", "DELETE", "OPTIONS"],
		allowedHeaders: ["Content-Type", "Authorization"],
	});
}

export default corsMiddleware;

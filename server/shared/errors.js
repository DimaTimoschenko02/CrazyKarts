export class HttpError extends Error {
	constructor(status, code, message, details) {
		super(message);
		this.name = "HttpError";
		this.status = status;
		this.code = code;
		this.details = details;
	}
}

export class NotFoundError extends HttpError {
	constructor(message = "Not found", details) {
		super(404, "not_found", message, details);
	}
}

export class ConflictError extends HttpError {
	constructor(message = "Conflict", details) {
		super(409, "conflict", message, details);
	}
}

export class ValidationError extends HttpError {
	constructor(message = "Validation failed", details) {
		super(400, "validation_error", message, details);
	}
}

export class UnauthorizedError extends HttpError {
	constructor(message = "Unauthorized", details) {
		super(401, "unauthorized", message, details);
	}
}

export function errorHandler(err, _req, res, _next) {
	if (err instanceof HttpError) {
		return res.status(err.status).json({
			error: err.code,
			message: err.message,
			...(err.details ? { details: err.details } : {}),
		});
	}
	if (err && err.message && err.message.startsWith("CORS:")) {
		return res.status(403).json({ error: "cors_blocked", message: err.message });
	}
	const message = err?.message || "Internal server error";
	res.status(500).json({ error: "internal", message });
}

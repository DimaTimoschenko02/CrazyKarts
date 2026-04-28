import config from "../config.js";

function emit(level, msg, extra) {
	const entry = {
		ts: new Date().toISOString(),
		level,
		msg,
		...(extra || {}),
	};
	const out = config.devMode
		? `[${entry.ts}] [${level}] ${msg}${extra ? " " + JSON.stringify(extra) : ""}`
		: JSON.stringify(entry);
	(level === "error" ? process.stderr : process.stdout).write(out + "\n");
}

export const logger = Object.freeze({
	info: (msg, extra) => emit("info", msg, extra),
	warn: (msg, extra) => emit("warn", msg, extra),
	error: (msg, extra) => emit("error", msg, extra),
	debug: (msg, extra) => {
		if (config.devMode) emit("debug", msg, extra);
	},
});

export default logger;

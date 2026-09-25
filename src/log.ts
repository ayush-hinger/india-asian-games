type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const min = order[(process.env.LOG_LEVEL as Level) ?? "info"] ?? 20;

function emit(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (order[level] < min) return;
  const line = { ts: new Date().toISOString(), level, msg, ...fields };
  const out = level === "error" || level === "warn" ? process.stderr : process.stdout;
  out.write(JSON.stringify(line, replacer) + "\n");
}

function replacer(_k: string, v: unknown) {
  if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack };
  return v;
}

export const log = {
  debug: (m: string, f?: Record<string, unknown>) => emit("debug", m, f),
  info: (m: string, f?: Record<string, unknown>) => emit("info", m, f),
  warn: (m: string, f?: Record<string, unknown>) => emit("warn", m, f),
  error: (m: string, f?: Record<string, unknown>) => emit("error", m, f),
  /** Schema drift is expected mid-Games: never crash the poller, record and move on. */
  drift: (where: string, detail: unknown) => emit("warn", "schema drift", { where, detail }),
};

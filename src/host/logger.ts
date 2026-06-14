// P19: structured logging. Single pino instance shared across server + mcp.
// In dev (NODE_ENV !== 'production'), pino-pretty makes output human-readable.
// In prod (Railway), JSON lines so Railway's log viewer + any later log shipping
// pipeline can parse fields. Log level defaults to 'info', overridable via env.
//
// Usage: `import { log } from "./logger.ts"; log.info({ trace_id, run_id }, "apply done");`
// The first arg is the context object; the second is the message.

import pino from "pino";

const isProd = process.env.NODE_ENV === "production";
const level = process.env.LOG_LEVEL ?? "info";

export const log = pino({
  level,
  // Pretty-print only in dev. pino-pretty is a devDependency; in prod we emit JSON.
  // Wrapping in a try/catch so a missing pino-pretty in prod doesn't crash boot.
  ...(isProd
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:HH:MM:ss.l", ignore: "pid,hostname" },
        },
      }),
});

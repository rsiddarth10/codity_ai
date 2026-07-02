import pino, { type Logger } from 'pino';

export type { Logger };

export interface LoggerOptions {
  name: string;
  level?: string;
}

/** Structured JSON logger (pino). One per process/component. */
export function createLogger(options: LoggerOptions): Logger {
  return pino({
    name: options.name,
    level: options.level ?? process.env.LOG_LEVEL ?? 'info',
    base: { pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

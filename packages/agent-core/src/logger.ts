export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];
export type LoggerLevel = LogLevel | 'off';
export type LoggerFields = Readonly<Record<string, unknown>>;

const LEVEL_RANK: Readonly<Record<LoggerLevel, number>> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  off: 4,
};

export interface LogRecord {
  readonly level: LogLevel;
  readonly time: string;
  readonly fields: LoggerFields;
  readonly msg?: string;
}

export interface LoggerDestination {
  write(record: LogRecord): void | Promise<void>;
}

export interface Logger {
  readonly level: LoggerLevel;
  child(bindings: LoggerFields): Logger;
  debug(fieldsOrMsg?: LoggerFields | string, msg?: string): void;
  info(fieldsOrMsg?: LoggerFields | string, msg?: string): void;
  warn(fieldsOrMsg?: LoggerFields | string, msg?: string): void;
  error(fieldsOrMsg?: LoggerFields | string, msg?: string): void;
}

export interface CreateLoggerOptions {
  readonly level?: LoggerLevel;
  readonly destination?: LoggerDestination;
  readonly bindings?: LoggerFields;
  readonly now?: () => Date;
}

export function isLogLevel(value: string | undefined): value is LogLevel {
  return LOG_LEVELS.includes(value as LogLevel);
}

export function isLoggerLevel(value: string | undefined): value is LoggerLevel {
  return value === 'off' || isLogLevel(value);
}

export function createSilentLogger(): Logger {
  return createLogger({ level: 'off' });
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const destination = options.destination;
  const bindings = jsonSafeFields(options.bindings ?? {});
  const now = options.now ?? (() => new Date());

  const emit = (recordLevel: LogLevel, fieldsOrMsg?: LoggerFields | string, msg?: string): void => {
    if (LEVEL_RANK[recordLevel] < LEVEL_RANK[level] || !destination) return;
    const { fields, message } = normalizeArgs(fieldsOrMsg, msg);
    const record: LogRecord = {
      level: recordLevel,
      time: now().toISOString(),
      fields: { ...bindings, ...fields },
      ...(message === undefined ? {} : { msg: message }),
    };
    try {
      void Promise.resolve(destination.write(record)).catch(() => {
        /* destinations must not affect callers */
      });
    } catch {
      /* destinations must not affect callers */
    }
  };

  return {
    level,
    child(childBindings) {
      return createLogger({
        level,
        ...(destination === undefined ? {} : { destination }),
        bindings: { ...bindings, ...jsonSafeFields(childBindings) },
        now,
      });
    },
    debug(fieldsOrMsg, message) {
      emit('debug', fieldsOrMsg, message);
    },
    info(fieldsOrMsg, message) {
      emit('info', fieldsOrMsg, message);
    },
    warn(fieldsOrMsg, message) {
      emit('warn', fieldsOrMsg, message);
    },
    error(fieldsOrMsg, message) {
      emit('error', fieldsOrMsg, message);
    },
  };
}

function normalizeArgs(
  fieldsOrMsg: LoggerFields | string | undefined,
  msg: string | undefined,
): { fields: LoggerFields; message?: string } {
  if (typeof fieldsOrMsg === 'string') {
    return { fields: {}, message: fieldsOrMsg };
  }
  const fields = jsonSafeFields(fieldsOrMsg ?? {});
  return msg === undefined ? { fields } : { fields, message: msg };
}

function jsonSafeFields(value: LoggerFields): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const safe = jsonSafeValue(entry);
    if (safe !== undefined) fields[key] = safe;
  }
  return fields;
}

function jsonSafeValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value !== 'object') return undefined;
  if (depth >= 8) return undefined;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
    };
  }
  if (Array.isArray(value)) {
    return value.map((entry) => jsonSafeValue(entry, depth + 1)).filter((entry) => entry !== undefined);
  }
  const record: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const safe = jsonSafeValue(entry, depth + 1);
    if (safe !== undefined) record[key] = safe;
  }
  return record;
}

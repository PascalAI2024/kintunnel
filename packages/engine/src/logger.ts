export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

export interface LogFields {
  [key: string]: string | number | boolean | null | undefined;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
  setLevel(level: LogLevel): void;
}

export interface CreateLoggerOptions {
  service?: string;
  level?: LogLevel;
  destination?: NodeJS.WritableStream;
  bindings?: LogFields;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100
};

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '{"__log_error":"serialization_failed"}';
  }
}

function safeWrite(destination: NodeJS.WritableStream, line: string): void {
  try {
    destination.write(line + "\n");
  } catch {
    // Never throw — logging must never crash the engine.
  }
}

export function createLogger(opts: CreateLoggerOptions = {}): Logger {
  const service = opts.service ?? "kintunnel-engine";
  let level: LogLevel = opts.level ?? "info";
  const destination = opts.destination ?? process.stdout;
  const bindings: LogFields = opts.bindings ?? {};

  function emit(recordLevel: LogLevel, message: string, fields?: LogFields): void {
    if (recordLevel === "silent") return;
    if (LEVEL_ORDER[recordLevel] < LEVEL_ORDER[level]) return;
    const entry: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level: recordLevel,
      service,
      message,
      ...bindings,
      ...(fields ?? {})
    };
    safeWrite(destination, safeStringify(entry));
  }

  return {
    debug(message, fields) {
      emit("debug", message, fields);
    },
    info(message, fields) {
      emit("info", message, fields);
    },
    warn(message, fields) {
      emit("warn", message, fields);
    },
    error(message, fields) {
      emit("error", message, fields);
    },
    child(childBindings) {
      return createLogger({
        service,
        level,
        destination,
        bindings: { ...bindings, ...childBindings }
      });
    },
    setLevel(newLevel) {
      level = newLevel;
    }
  };
}
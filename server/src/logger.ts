/**
 * Minimal structured logger matching the Python backend's output shape:
 *   <iso-timestamp> cloakbrowser.manager.<scope> <LEVEL> <message>
 */

type Level = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';

const LEVEL_ORDER: Record<Level, number> = {
  DEBUG: 10,
  INFO: 20,
  WARNING: 30,
  ERROR: 40,
};

const threshold =
  LEVEL_ORDER[(process.env.LOG_LEVEL?.toUpperCase() as Level) ?? 'INFO'] ??
  LEVEL_ORDER.INFO;

function emit(scope: string, level: Level, msg: string): void {
  if (LEVEL_ORDER[level] < threshold) return;
  const line = `${new Date().toISOString()} cloakbrowser.manager.${scope} ${level} ${msg}`;
  if (level === 'ERROR' || level === 'WARNING') console.error(line);
  else console.log(line);
}

export function logger(scope: string) {
  return {
    debug: (msg: string) => emit(scope, 'DEBUG', msg),
    info: (msg: string) => emit(scope, 'INFO', msg),
    warn: (msg: string) => emit(scope, 'WARNING', msg),
    error: (msg: string) => emit(scope, 'ERROR', msg),
  };
}

export type Logger = ReturnType<typeof logger>;

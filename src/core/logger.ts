import { appendFileSync } from "node:fs"

// ---------------------------------------------------------------------------
// Color utilities
// ---------------------------------------------------------------------------

export const useColor = !process.env.NO_COLOR && process.stdout?.isTTY !== false

/** Raw ANSI escape codes — use for conditional paint(s, code, flag) patterns. */
export const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
}

/** Wrap a string with color — respects NO_COLOR and TTY detection. */
const wrap = (code: string) => (s: string) => useColor ? `${code}${s}${ANSI.reset}` : s

export const c = {
  red:    wrap(ANSI.red),
  yellow: wrap(ANSI.yellow),
  green:  wrap(ANSI.green),
  cyan:   wrap(ANSI.cyan),
  dim:    wrap(ANSI.dim),
  bold:   wrap(ANSI.bold),
  gray:   wrap(ANSI.gray),
}

/** Check color support, with an optional --no-color flag override. */
export function shouldUseColor(flag?: { noColor?: boolean }): boolean {
  if (flag?.noColor) return false
  return useColor
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

type LogLevel = "debug" | "info" | "warn" | "error"

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

const LEVEL_COLOR: Record<LogLevel, (s: string) => string> = {
  debug: c.gray,
  info: c.cyan,
  warn: c.yellow,
  error: c.red,
}

let currentLevel: LogLevel = "info"

export function setLogLevel(level: LogLevel) {
  currentLevel = level
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[currentLevel]
}

export function formatLogMsg(level: LogLevel, component: string, msg: string): string {
  const now = new Date()
  const ts = now.toLocaleTimeString("en-GB", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3 })
  const colorFn = LEVEL_COLOR[level]
  return `${c.dim(ts)} ${colorFn(`[${level.toUpperCase().padEnd(5)}]`)} ${c.dim(`[${component}]`)} ${msg}`
}

/** Append a line to a log file (no-op if path is null). */
export function appendLogLine(logFile: string | null | undefined, line: string) {
  if (logFile) {
    try { appendFileSync(logFile, line + "\n") } catch { /* ignore */ }
  }
}

export function createLogger(component: string) {
  return {
    debug(msg: string) {
      if (shouldLog("debug")) console.log(formatLogMsg("debug", component, msg))
    },
    info(msg: string) {
      if (shouldLog("info")) console.log(formatLogMsg("info", component, msg))
    },
    warn(msg: string) {
      if (shouldLog("warn")) console.warn(formatLogMsg("warn", component, msg))
    },
    error(msg: string) {
      if (shouldLog("error")) console.error(formatLogMsg("error", component, msg))
    },
  }
}

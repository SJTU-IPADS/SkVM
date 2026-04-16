/**
 * Lightweight CLI spinner for long-running operations.
 *
 * Features:
 *   - Braille-dot animation at ~80 ms
 *   - Elapsed-time display (auto-formatted: 12s / 2m 14s / 1h 2m)
 *   - Respects NO_COLOR and non-TTY (falls back to silent)
 *   - Only one spinner active at a time (creating a new one stops the previous)
 *   - Logger-aware: the logger calls pause/resume so log lines print cleanly
 */

import { useColor, c, setSpinnerHooks } from "./logger.ts"

// ---------------------------------------------------------------------------
// Animation frames
// ---------------------------------------------------------------------------

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const INTERVAL_MS = 80

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const isTTY = process.stdout?.isTTY === true

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const sec = s % 60
  if (m < 60) return `${m}m ${sec}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "")
}

// ---------------------------------------------------------------------------
// Singleton active spinner
// ---------------------------------------------------------------------------

let active: SpinnerImpl | null = null

// ---------------------------------------------------------------------------
// Spinner implementation
// ---------------------------------------------------------------------------

export interface Spinner {
  /** Update the displayed text (spinner keeps running). */
  update(text: string): void
  /** Stop the spinner with a ✓ prefix and print a final line. */
  succeed(text?: string): void
  /** Stop the spinner with a ✗ prefix and print a final line. */
  fail(text?: string): void
  /** Stop the spinner without printing anything. */
  stop(): void
}

class SpinnerImpl implements Spinner {
  private text: string
  private startTime: number
  private frameIndex = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private lastLen = 0

  constructor(text: string) {
    this.text = text
    this.startTime = Date.now()
  }

  start(): void {
    if (active) active.stop()
    active = this
    setSpinnerHooks({ pause: () => this.pause(), resume: () => this.resume() })
    if (isTTY) {
      this.render()
      this.timer = setInterval(() => {
        this.frameIndex = (this.frameIndex + 1) % FRAMES.length
        this.render()
      }, INTERVAL_MS)
    }
  }

  // -- Public API -----------------------------------------------------------

  update(text: string): void {
    if (text === this.text) return
    this.text = text
    if (isTTY) this.render()
  }

  succeed(text?: string): void {
    this.clear()
    this.kill()
    const elapsed = formatElapsed(Date.now() - this.startTime)
    const t = text ?? this.text
    const mark = useColor ? c.green("✓") : "✓"
    process.stdout.write(`${mark} ${t}  ${c.dim(`(${elapsed})`)}\n`)
  }

  fail(text?: string): void {
    this.clear()
    this.kill()
    const elapsed = formatElapsed(Date.now() - this.startTime)
    const t = text ?? this.text
    const mark = useColor ? c.red("✗") : "✗"
    process.stdout.write(`${mark} ${t}  ${c.dim(`(${elapsed})`)}\n`)
  }

  stop(): void {
    this.clear()
    this.kill()
  }

  // -- Logger integration ---------------------------------------------------

  /** Temporarily hide the spinner (called by logger before printing). */
  pause(): void {
    if (isTTY) this.clear()
  }

  /** Redraw the spinner (called by logger after printing). */
  resume(): void {
    if (isTTY) this.render()
  }

  // -- Internal -------------------------------------------------------------

  private render(): void {
    if (!isTTY) return
    const elapsed = formatElapsed(Date.now() - this.startTime)
    const frame = useColor ? c.cyan(FRAMES[this.frameIndex]!) : FRAMES[this.frameIndex]!
    const line = `${frame} ${this.text}  ${c.dim(elapsed)}`
    const plainLen = stripAnsi(line).length
    const pad = this.lastLen > plainLen ? " ".repeat(this.lastLen - plainLen) : ""
    process.stdout.write(`\r${line}${pad}`)
    this.lastLen = plainLen
  }

  private clear(): void {
    if (isTTY && this.lastLen > 0) {
      process.stdout.write(`\r${" ".repeat(this.lastLen)}\r`)
      this.lastLen = 0
    }
  }

  private kill(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (active === this) {
      active = null
      setSpinnerHooks(null)
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create and start a spinner. Only one spinner can be active at a time —
 * creating a new spinner automatically stops the previous one.
 */
export function createSpinner(text: string): Spinner {
  const s = new SpinnerImpl(text)
  s.start()
  return s
}

/**
 * Print a line while respecting the active spinner — clears the spinner,
 * writes the line, then redraws. Use this instead of console.log for lines
 * that may appear during spinner lifetime outside of the logger.
 */
export function spinnerLog(msg: string): void {
  if (active) {
    active.pause()
    process.stdout.write(msg + "\n")
    active.resume()
  } else {
    process.stdout.write(msg + "\n")
  }
}

// ---------------------------------------------------------------------------
// Progress spinner (done/total counter pattern)
// ---------------------------------------------------------------------------

export interface ProgressSpinner {
  /** Increment done count. On the final tick, succeed with `succeedMsg`
   *  if provided, otherwise stop silently. */
  tick(succeedMsg?: string): void
  /** Force-stop the spinner (idempotent). */
  stop(): void
}

/**
 * Create a spinner that tracks `[done/total]` progress. Encapsulates the
 * counter, update-on-tick, and succeed-on-final pattern used across bench,
 * profiler, and compiler orchestrators.
 */
export function createProgressSpinner(label: string, total: number): ProgressSpinner {
  if (total === 0) return { tick() {}, stop() {} }
  const sp = createSpinner(`${label} [0/${total}]...`)
  let done = 0
  let stopped = false
  return {
    tick(succeedMsg?: string) {
      if (stopped) return
      done++
      if (done >= total) {
        stopped = true
        if (succeedMsg) sp.succeed(succeedMsg)
        else sp.stop()
      } else {
        sp.update(`${label} [${done}/${total}]...`)
      }
    },
    stop() {
      if (stopped) return
      stopped = true
      sp.stop()
    },
  }
}

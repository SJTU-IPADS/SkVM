/**
 * Hand-rolled flag-definition layer for skvm subcommands. See #49.
 *
 * Each subcommand declares its flags once with `defineFlags()`; the returned
 * definition parses argv into a typed config object, generates the `--help`
 * text from the same declarations (so help can never drift from the flags),
 * and rejects unknown flags with the exact same typo-aware wording as the
 * legacy `assertKnownFlags` path (`src/core/cli-flags.ts`, #12).
 *
 * Documented CLI conventions are preserved exactly:
 * - Flags are `--key=value` ONLY. There is no space-separated form; non-flag
 *   argv entries are ignored by `parse()` (same as the legacy `parseFlags`).
 * - A bare `--flag` means `--flag=true`.
 * - Global flags (`--help`, `--verbose`, `--skvm-cache`, `--skvm-data-dir`,
 *   `--tmp-dir`) are always accepted without per-command declaration.
 * - An empty value (`--key=`) on a string/bool flag is treated as "flag not
 *   provided" (the truthiness checks the legacy handlers used). On
 *   int/float/enum flags it is rejected like any other unparseable value —
 *   the legacy handlers errored on empty `--timeout-ms=` / `--adapter=`, and
 *   silently substituting a default would hide the typo.
 *
 * `parse()` is pure: it throws `UsageError` instead of printing/exiting, so
 * subcommand handlers are unit-testable without spawning the CLI. The thin
 * impure wrapper `parseOrExit()` is what `src/index.ts` calls: it prints the
 * error and exits 1, or prints the generated help and exits 0 when `--help`
 * was requested.
 */

import { GLOBAL_FLAGS, formatUnknownFlagErrors } from "../core/cli-flags.ts"

// ---------------------------------------------------------------------------
// Spec types
// ---------------------------------------------------------------------------

export interface StringFlag {
  kind: "string"
  required?: boolean
  default?: string
  /** Value placeholder in generated help, e.g. `<type>`. Default: `<value>`. */
  placeholder?: string
  help?: string
}

export interface IntFlag {
  kind: "int"
  required?: boolean
  default?: number
  /** Inclusive lower bound. */
  min?: number
  /** Inclusive upper bound. */
  max?: number
  /** Value placeholder in generated help. Default: `<n>`. */
  placeholder?: string
  help?: string
}

export interface FloatFlag {
  kind: "float"
  required?: boolean
  default?: number
  /** Inclusive lower bound. */
  min?: number
  /** Inclusive upper bound. */
  max?: number
  /** Value placeholder in generated help. Default: `<n>`. */
  placeholder?: string
  help?: string
}

export interface BoolFlag {
  kind: "bool"
  /** Default when the flag is absent. Default: false. */
  default?: boolean
  help?: string
}

export interface EnumFlag {
  kind: "enum"
  values: readonly string[]
  required?: boolean
  default?: string
  /** Value placeholder in generated help. Default: `<v1|v2|...>`. */
  placeholder?: string
  help?: string
}

/**
 * Deprecated alias: `--old-name=x` is read as `--target=x`. The canonical
 * flag wins when both are given. Aliases are accepted silently and are not
 * rendered in the generated help.
 */
export interface AliasFlag {
  aliasOf: string
}

export type FlagSpec = StringFlag | IntFlag | FloatFlag | BoolFlag | EnumFlag | AliasFlag
export type FlagSpecs = Record<string, FlagSpec>

/**
 * Optional prose rendered around the generated Options block. Both fields are
 * static text only — defaults and required markers still come from the flag
 * declarations, so the generated-from-declarations property is preserved.
 */
export interface DefineFlagsOptions {
  /** `Usage:` lines rendered between the summary and the Options block. */
  usage?: readonly string[]
  /** Free-form block (e.g. `Notes:`) rendered after the Options block. */
  epilogue?: string
}

// ---------------------------------------------------------------------------
// Typed-config derivation
// ---------------------------------------------------------------------------

type FlagValue<F extends FlagSpec> =
  F extends { kind: "enum"; values: readonly (infer V extends string)[] } ? V
  : F extends { kind: "int" } ? number
  : F extends { kind: "float" } ? number
  : F extends { kind: "bool" } ? boolean
  : F extends { kind: "string" } ? string
  : never

/** The typed config object produced by `parse()` (alias keys excluded). */
export type FlagConfig<S extends FlagSpecs> = {
  [K in keyof S as S[K] extends AliasFlag ? never : K]:
    S[K] extends { kind: "bool" } ? boolean
    : S[K] extends { required: true } ? FlagValue<S[K]>
    : S[K] extends { default: string | number } ? FlagValue<S[K]>
    : FlagValue<S[K]> | undefined
}

/**
 * `--help` short-circuits validation (so `skvm <cmd> --help` works even when
 * required flags are missing), hence the discriminated union.
 */
export type ParseResult<S extends FlagSpecs> =
  | { help: true }
  | ({ help: false } & FlagConfig<S>)

/** Extract the typed config of a definition: `type LogsConfig = ConfigOf<typeof LOGS_FLAGS>`. */
export type ConfigOf<D> = D extends FlagsDef<infer S> ? FlagConfig<S> : never

export interface FlagsDef<S extends FlagSpecs> {
  readonly command: string
  /** Parse argv (`--key=value` entries) into a typed config. Throws UsageError. */
  parse(argv: string[]): ParseResult<S>
  /** Help text generated from the declarations. */
  help(): string
}

// ---------------------------------------------------------------------------
// UsageError
// ---------------------------------------------------------------------------

/**
 * Thrown by `parse()` on any user input error. Carries the generated help
 * text, built lazily — the current CLI error path prints only the message.
 */
export class UsageError extends Error {
  readonly #buildHelp: () => string

  constructor(message: string, buildHelp: () => string) {
    super(message)
    this.name = "UsageError"
    this.#buildHelp = buildHelp
  }

  get help(): string {
    return this.#buildHelp()
  }
}

// ---------------------------------------------------------------------------
// defineFlags
// ---------------------------------------------------------------------------

export function defineFlags<const S extends FlagSpecs>(
  command: string,
  summary: string,
  spec: S,
  options?: DefineFlagsOptions,
): FlagsDef<S> {
  // -- Define-time validation (programmer errors → plain Error) --------------
  const dataEntries: Array<[string, Exclude<FlagSpec, AliasFlag>]> = []
  const aliasesByTarget = new Map<string, string[]>()

  for (const [name, s] of Object.entries(spec) as Array<[string, FlagSpec]>) {
    if (GLOBAL_FLAGS.has(name)) {
      throw new Error(`defineFlags(${command}): --${name} is a global flag and cannot be redeclared`)
    }
    if ("aliasOf" in s) continue
    dataEntries.push([name, s])
    if (s.kind !== "bool" && s.required && s.default !== undefined) {
      throw new Error(`defineFlags(${command}): --${name} cannot be both required and have a default`)
    }
    if (s.kind === "enum" && s.default !== undefined && !s.values.includes(s.default)) {
      throw new Error(`defineFlags(${command}): --${name} default "${s.default}" is not in values`)
    }
    if (
      (s.kind === "int" || s.kind === "float") &&
      s.default !== undefined &&
      s.min !== undefined &&
      s.default < s.min
    ) {
      throw new Error(`defineFlags(${command}): --${name} default ${s.default} is below min ${s.min}`)
    }
    if (
      (s.kind === "int" || s.kind === "float") &&
      s.default !== undefined &&
      s.max !== undefined &&
      s.default > s.max
    ) {
      throw new Error(`defineFlags(${command}): --${name} default ${s.default} is above max ${s.max}`)
    }
  }
  for (const [name, s] of Object.entries(spec) as Array<[string, FlagSpec]>) {
    if (!("aliasOf" in s)) continue
    const target = spec[s.aliasOf]
    if (target === undefined || "aliasOf" in target) {
      throw new Error(`defineFlags(${command}): --${name} aliasOf "${s.aliasOf}" must name a declared non-alias flag`)
    }
    const list = aliasesByTarget.get(s.aliasOf) ?? []
    list.push(name)
    aliasesByTarget.set(s.aliasOf, list)
  }

  const knownKeys: ReadonlySet<string> = new Set(Object.keys(spec))

  // -- Help generation --------------------------------------------------------
  function help(): string {
    const rows: Array<[string, string]> = dataEntries.map(([name, s]) => {
      const left = s.kind === "bool" ? `--${name}` : `--${name}=${s.placeholder ?? defaultPlaceholder(s)}`
      // Declared defaults and required markers render automatically so flag
      // authors never repeat them in prose (the drift this layer exists to
      // kill). Bool defaults stay silent — absent simply means false.
      let text = s.help ?? ""
      if (s.kind !== "bool" && s.default !== undefined) {
        text = text ? `${text} (default: ${s.default})` : `(default: ${s.default})`
      } else if (s.kind !== "bool" && s.required) {
        text = text ? `${text} (required)` : "(required)"
      }
      return [left, text]
    })
    const lines = [`skvm ${command} - ${summary}`]
    if (options?.usage !== undefined && options.usage.length > 0) {
      lines.push("", "Usage:")
      for (const u of options.usage) lines.push(`  ${u}`)
    }
    // Flagless subcommands (e.g. `proposals reject <id>`) declare an empty
    // spec; skip the Options block entirely — a dangling "Options:" header
    // (and Math.max over zero rows) would render nonsense.
    if (rows.length > 0) {
      const width = Math.max(...rows.map(([left]) => left.length)) + 4
      lines.push("", "Options:")
      for (const [left, text] of rows) {
        const [first = "", ...rest] = text.split("\n")
        lines.push(`  ${left.padEnd(width)}${first}`.trimEnd())
        for (const cont of rest) {
          lines.push(`  ${" ".repeat(width)}${cont}`.trimEnd())
        }
      }
    }
    if (options?.epilogue !== undefined && options.epilogue !== "") {
      lines.push("", options.epilogue)
    }
    return lines.join("\n")
  }

  // -- parse ------------------------------------------------------------------
  function usage(message: string): UsageError {
    return new UsageError(message, help)
  }

  function coerce(name: string, s: Exclude<FlagSpec, AliasFlag>, value: string | undefined): unknown {
    if (s.kind === "bool") {
      if (value === undefined) return s.default ?? false
      if (value === "true") return true
      if (value === "false") return false
      throw usage(`${command}: --${name} expects true or false, got "${value}"`)
    }
    if (value === undefined) {
      if (s.required) throw usage(`${command}: --${name} is required`)
      return s.default
    }
    switch (s.kind) {
      case "int": {
        if (!/^[+-]?\d+$/.test(value)) {
          throw usage(`${command}: --${name} expects an integer, got "${value}"`)
        }
        const n = parseInt(value, 10)
        if (s.min !== undefined && n < s.min) {
          throw usage(`${command}: --${name} must be >= ${s.min}, got ${n}`)
        }
        if (s.max !== undefined && n > s.max) {
          throw usage(`${command}: --${name} must be <= ${s.max}, got ${n}`)
        }
        return n
      }
      case "float": {
        // Plain decimal notation only — exponent form (1e3) is rejected by
        // design; CLI flag values should read literally.
        if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(value)) {
          throw usage(`${command}: --${name} expects a number, got "${value}"`)
        }
        const n = parseFloat(value)
        if (s.min !== undefined && n < s.min) {
          throw usage(`${command}: --${name} must be >= ${s.min}, got ${n}`)
        }
        if (s.max !== undefined && n > s.max) {
          throw usage(`${command}: --${name} must be <= ${s.max}, got ${n}`)
        }
        return n
      }
      case "enum": {
        if (!s.values.includes(value)) {
          throw usage(invalidEnumMessage(command, name, value, s.values))
        }
        return value
      }
      case "string":
        return value
    }
  }

  function parse(argv: string[]): ParseResult<S> {
    // Same surface as the legacy parseFlags in src/index.ts: only `--`-prefixed
    // entries are flags, a bare `--flag` means "true", last occurrence wins.
    // (Improvement over the legacy split("="): values may contain `=`.)
    const raw: Record<string, string> = {}
    for (const arg of argv) {
      if (!arg.startsWith("--")) continue
      const body = arg.slice(2)
      const eq = body.indexOf("=")
      const key = eq === -1 ? body : body.slice(0, eq)
      const value = eq === -1 ? "true" : body.slice(eq + 1)
      raw[key] = value
    }

    // Unknown-flag rejection comes first (same order as the legacy handlers:
    // `skvm logs --help --bogus` errors rather than printing help).
    const unknownLines = formatUnknownFlagErrors(command, Object.keys(raw), knownKeys)
    if (unknownLines.length > 0) throw usage(unknownLines.join("\n"))

    if (raw.help === "true") return { help: true }

    const config: Record<string, unknown> = { help: false }
    for (const [name, s] of dataEntries) {
      let value: string | undefined = raw[name]
      if (value === undefined) {
        for (const alias of aliasesByTarget.get(name) ?? []) {
          const v = raw[alias]
          if (v !== undefined) {
            value = v
            break
          }
        }
      }
      // Empty value (`--key=`): for string/bool flags it counts as "not
      // provided" (the truthiness semantics of the legacy handlers); for
      // int/float/enum flags it falls through to coercion, which rejects ""
      // like any other unparseable value — the legacy handlers errored on
      // empty --timeout-ms= / --adapter=, and silently substituting a
      // default would hide the typo.
      if (value === "" && (s.kind === "string" || s.kind === "bool")) value = undefined
      config[name] = coerce(name, s, value)
    }
    return config as ParseResult<S>
  }

  return { command, parse, help }
}

function defaultPlaceholder(s: StringFlag | IntFlag | FloatFlag | EnumFlag): string {
  switch (s.kind) {
    case "int":
    case "float":
      return "<n>"
    case "enum":
      return `<${s.values.join("|")}>`
    case "string":
      return "<value>"
  }
}

/** The layer's one enum-rejection wording, shared by coerce() and parseEnumListFlag. */
function invalidEnumMessage(command: string, name: string, value: string, values: readonly string[]): string {
  return `${command}: invalid --${name} "${value}". Valid: ${values.join(", ")}`
}

// ---------------------------------------------------------------------------
// Comma-separated multi-enum values
// ---------------------------------------------------------------------------

/**
 * Validate a comma-separated multi-enum flag value (e.g. `--adapter=pi,opencode`).
 * The single-value enum kind can't express comma lists, so handlers parse them;
 * this owns the split/trim + per-entry validation with the layer's standard
 * enum wording. Throws UsageError naming the first invalid entry.
 */
export function parseEnumListFlag<V extends string>(
  command: string,
  flag: string,
  raw: string,
  values: readonly V[],
  buildHelp: () => string,
): V[] {
  const entries = raw.split(",").map((s) => s.trim())
  for (const entry of entries) {
    if (!(values as readonly string[]).includes(entry)) {
      throw new UsageError(invalidEnumMessage(command, flag, entry, values), buildHelp)
    }
  }
  return entries as V[]
}

// ---------------------------------------------------------------------------
// CLI shell wrapper
// ---------------------------------------------------------------------------

/**
 * UsageError → stderr + exit 1; anything else propagates to the crash handler.
 * Exported for the proposals router (`src/cli/proposals.ts`), which parses
 * per-sub argv itself instead of going through `runOrExit` and needs the same
 * exit path for handler-thrown UsageErrors.
 */
export function exitOnUsageError(err: unknown): never {
  if (err instanceof UsageError) {
    console.error(err.message)
    process.exit(1)
  }
  throw err
}

/**
 * The impure entry used by `src/index.ts`: parse argv, printing the error to
 * stderr and exiting 1 on UsageError (same behavior as the legacy
 * `assertKnownFlags` / inline-validation paths), or printing the generated
 * help to stdout and exiting 0 when `--help` was requested.
 */
export function parseOrExit<S extends FlagSpecs>(def: FlagsDef<S>, argv: string[]): FlagConfig<S> {
  let result: ParseResult<S>
  try {
    result = def.parse(argv)
  } catch (err) {
    exitOnUsageError(err)
  }
  if (result.help === true) {
    console.log(def.help())
    process.exit(0)
  }
  return result
}

/**
 * `parseOrExit` + execute. The layer validates single flags only; cross-flag
 * rules (mutually exclusive flags, conditional requirements) live in the
 * handler operating on the typed config and throw `UsageError`. This wrapper
 * gives those errors the same exit path as parse errors: message to stderr,
 * exit 1. Anything else propagates to the caller's crash handler.
 *
 * The catch wraps the WHOLE handler, but it performs no cleanup — handlers
 * must throw UsageError during up-front validation, before any side effects
 * (sessions, workdirs, subprocesses) begin.
 */
export async function runOrExit<S extends FlagSpecs>(
  def: FlagsDef<S>,
  argv: string[],
  handler: (config: FlagConfig<S>) => void | Promise<void>,
): Promise<void> {
  const config = parseOrExit(def, argv)
  try {
    await handler(config)
  } catch (err) {
    exitOnUsageError(err)
  }
}

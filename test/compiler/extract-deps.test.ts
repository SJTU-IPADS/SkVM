import { describe, expect, test } from "bun:test"
import {
  extractPythonImportHints,
  sanitizeDependencies,
} from "../../src/compiler/passes/bind-env/extract-deps.ts"
import type { DependencyEntry } from "../../src/core/types.ts"

describe("extractPythonImportHints", () => {
  test("captures one hint per import line — does not span lines", () => {
    // Regression: the previous regex used `\s` inside a character class,
    // which matches `\n`, so a greedy match would swallow subsequent
    // `import` lines into a single "name" capture (e.g. "json\nimport sys").
    const files = new Map([[
      "scripts/baseball.py",
      `import json\nimport sys\nfrom datetime import datetime, timezone\nimport pytz\n`,
    ]])
    const hints = extractPythonImportHints(files)
    // json/sys/datetime are stdlib and excluded; pytz is third-party
    expect(hints.map((h) => h.module)).toEqual(["pytz"])
  })

  test("excludes stdlib modules", () => {
    const files = new Map([[
      "x.py",
      `import os\nimport sys\nfrom pathlib import Path\nimport pandas as pd\n`,
    ]])
    expect(extractPythonImportHints(files).map((h) => h.module)).toEqual(["pandas"])
  })

  test("handles `import a, b, c` correctly", () => {
    const files = new Map([[
      "x.py",
      `import requests, pandas, json\n`,
    ]])
    const hints = extractPythonImportHints(files).map((h) => h.module).sort()
    expect(hints).toEqual(["pandas", "requests"])
  })

  test("scans .md and SKILL.md but ignores other extensions", () => {
    const files = new Map([
      ["a.py", `import requests\n`],
      ["b.txt", `import pandas\n`],
      ["SKILL.md", "```python\nimport numpy\n```\n"],
    ])
    expect(extractPythonImportHints(files).map((h) => h.module).sort()).toEqual(["numpy", "requests"])
  })
})

describe("sanitizeDependencies", () => {
  function pip(name: string, source: DependencyEntry["source"] = "python-import", confidence = 0.6): DependencyEntry {
    return {
      name,
      type: "pip",
      checkCommand: `python -m pip show ${name}`,
      installCommand: `python -m pip install ${name}`,
      required: true,
      source,
      confidence,
    }
  }

  test("drops names with whitespace or newlines (LLM parser confusion)", () => {
    const out = sanitizeDependencies(
      [
        pip("json\nimport sys"),
        pip("timezone\nfrom urllib"),
        pip("pandas"),
      ],
      [{ module: "pandas", count: 1 }],
    )
    expect(out.map((d) => d.name)).toEqual(["pandas"])
  })

  test("drops Python stdlib modules tagged as pip", () => {
    const out = sanitizeDependencies(
      [pip("json"), pip("argparse"), pip("urllib"), pip("requests")],
      [{ module: "requests", count: 1 }],
    )
    expect(out.map((d) => d.name)).toEqual(["requests"])
  })

  test("drops low-confidence pip deps the local scan didn't see (LLM hallucination)", () => {
    const out = sanitizeDependencies(
      [pip("mlb_api", "python-import", 0.6), pip("pytz", "python-import", 0.6)],
      [{ module: "pytz", count: 2 }],
    )
    expect(out.map((d) => d.name)).toEqual(["pytz"])
  })

  test("keeps high-confidence pip deps even when local scan missed them", () => {
    const out = sanitizeDependencies(
      [pip("complex-runtime-dep", "python-import", 0.95)],
      [],
    )
    expect(out.map((d) => d.name)).toEqual(["complex-runtime-dep"])
  })

  test("does not interfere with system or shell-command deps", () => {
    const sys: DependencyEntry = {
      name: "ffmpeg",
      type: "system",
      checkCommand: "command -v ffmpeg",
      required: true,
      source: "shell-command",
      confidence: 0.9,
    }
    const out = sanitizeDependencies([sys], [])
    expect(out).toEqual([sys])
  })

  test("preserves pip deps from non-python-import sources even at low confidence", () => {
    // A pip dep the LLM picked up from a `pip install` comment, not from a
    // Python import — local import scan would never see it. Don't filter.
    const out = sanitizeDependencies(
      [pip("rare-tool", "comment", 0.5)],
      [],
    )
    expect(out.map((d) => d.name)).toEqual(["rare-tool"])
  })
})

import type { LLMProvider } from "../../../providers/types.ts"
import type { DependencyEntry, TokenUsage } from "../../../core/types.ts"
import { createLogger } from "../../../core/logger.ts"
import type { PlatformContext } from "./platform.ts"
import type { InstallPolicy } from "./install-policy.ts"

import TEMPLATE from "./env-binding-template.sh" with { type: "text" }

const log = createLogger("pass2:script")

const EMPTY_SCRIPT = `#!/bin/bash\n# No dependencies detected\nexit 0\n`

/**
 * Phase B: Generate env-binding script from template + dependencies.
 *
 * Sends the template and dependency list to the LLM, which generates
 * the concrete env-setup.sh following the template pattern.
 *
 * Returns the empty fallback script if there are no dependencies.
 */
export async function generateBindingScript(
  dependencies: DependencyEntry[],
  provider: LLMProvider,
  platform: PlatformContext,
  policy: InstallPolicy,
): Promise<{ script: string; tokens: TokenUsage }> {
  if (dependencies.length === 0) {
    return { script: EMPTY_SCRIPT, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
  }

  const depsJson = JSON.stringify(dependencies, null, 2)
  const platformJson = JSON.stringify(platform, null, 2)
  const policyJson = JSON.stringify(policy, null, 2)

  const response = await provider.complete({
    messages: [{
      role: "user",
      content: `Generate an env-binding bash script for the following dependencies, following the template pattern exactly.

## Template
\`\`\`bash
${TEMPLATE}
\`\`\`

## Dependencies
\`\`\`json
${depsJson}
\`\`\`

## Platform Context
\`\`\`json
${platformJson}
\`\`\`

## Installation Policy
\`\`\`json
${policyJson}
\`\`\`

Generate the complete bash script. Emit one check-then-install block per dependency, following the template pattern.
Apply platform-aware installation choices:
- pip dependencies MUST go through the template's pip_check / pip_install helpers — never call pip, pip3, or python -m pip directly. The helpers resolve the right interpreter and bootstrap a private venv when the platform has no usable pip (see packageManagers.pip in the Platform Context).
- System dependencies: detect available installers first, then use bounded install commands.
- Do NOT run repository refresh commands or system upgrades (for example: apt-get update, apt update, yum update, dnf update, brew update, upgrade).

Output ONLY the script content, no markdown fences, no explanation.`,
    }],
    system: `You are a bash script generator for SkVM environment binding.

Given a template and a list of dependencies (each with name, type, checkCommand, installCommand), generate a concrete idempotent bash script.

Rules:
- Start with #!/bin/bash and set -euo pipefail
- Include the log() and warn() helper functions from the template
- Copy the python bootstrap helpers (PY variable, bootstrap_venv, ensure_python, pip_check, pip_install) from the template VERBATIM, and route every pip dependency through pip_check/pip_install
- For each dependency, emit a check block: if checkCommand succeeds, log present; else install and track failures
- Redirect check commands to /dev/null (stdout and stderr)
- Use || to catch install failures without aborting the script
- End with the FAIL counter check from the template
- Keep all comments and messages in English.
- ALWAYS single-quote pip install arguments that contain version specifiers (>=, <=, ==, ~=, !=), e.g. pip install 'package>=1.0' — unquoted operators like >= are interpreted as shell redirects.
- Do NOT include repository refresh or upgrade operations (no apt-get update/upgrade, apt update/upgrade, yum update, dnf update/upgrade, brew update/upgrade).
- Output ONLY the bash script, nothing else`,
    temperature: 0,
    // The template's helper block alone is ~50 lines the model is told to copy
    // verbatim, before a single dependency block. 4096 truncated a long script
    // mid-line, and a truncated script fails `bash -n` — which the repair loop
    // then treats as a content error and tries to fix, burning attempts on
    // output that was never wrong, only cut off.
    maxTokens: 8192,
  })

  // A response that hit the cap is truncated, not broken. Saying so is the
  // difference between one clear failure and five repair attempts against a
  // syntax error that has no cause in the script's content.
  if (response.stopReason === "max_tokens") {
    throw new Error(
      "pass2: the generated env-binding script hit the output token cap and is truncated. " +
      "Reduce the dependency count for this skill, or raise the cap.",
    )
  }

  let script = response.text.trim()

  // Strip markdown fences if the LLM wrapped the output
  script = script.replace(/^```(?:bash)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim()

  // Ensure script starts with shebang
  if (!script.startsWith("#!/bin/bash")) {
    script = `#!/bin/bash\n${script}`
  }

  log.info(`Generated binding script (${script.length} chars)`)
  return { script, tokens: response.tokens }
}

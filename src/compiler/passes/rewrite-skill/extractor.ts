import type { SCR } from "../../../core/types.ts"
import { SCRSchema } from "../../../core/types.ts"
import type { LLMProvider } from "../../../providers/types.ts"
import { extractStructured } from "../../../providers/structured.ts"
import { ALL_PRIMITIVE_IDS } from "../../../core/primitives.ts"
import { createLogger } from "../../../core/logger.ts"
import scrTemplateObj from "./scr-template.json"

const log = createLogger("extractor")

const scrTemplate = JSON.stringify(scrTemplateObj, null, 2)

/**
 * Extract SCR (Skill Capability Requirement) from a skill document using LLM.
 *
 * Decomposes the skill into purposes, maps each to primitive capabilities.
 */
export async function extractSCR(
  skillContent: string,
  provider: LLMProvider,
): Promise<SCR> {
  const primitiveList = ALL_PRIMITIVE_IDS.map((id) => `  - ${id}`).join("\n")

  const prompt = `Analyze the following skill document and extract its capability requirements.

## Task

Decompose the skill into distinct **purposes** (functional goals). For each purpose:
1. Identify which primitive capabilities are needed and at what proficiency level (L1, L2, or L3)
2. Provide evidence from the skill text explaining why each capability at that level is needed
3. If possible, identify alternative implementation paths that could achieve the same goal using different capabilities

## Available Primitive Capabilities

${primitiveList}

Each has 3 proficiency levels:
- L1: Basic usage
- L2: Intermediate usage (standard libraries, multiple files, etc.)
- L3: Advanced usage (third-party libs, complex patterns, etc.)

## Skill Document

${skillContent}

## Output Template

Fill in the following JSON structure. Each string value describes what to put there:

\`\`\`json
${scrTemplate}
\`\`\``

  const system = "You are a skill compiler analyzing capability requirements. Be precise about which primitives are needed and at what level."

  const { result } = await extractStructured({
    provider,
    schema: SCRSchema,
    schemaName: "extract_scr",
    schemaDescription: "Extract skill capability requirements (SCR) from a skill document",
    prompt,
    system,
  })

  // Ensure defaults are applied (alternativePaths)
  for (const purpose of result.purposes) {
    if (!purpose.alternativePaths) {
      purpose.alternativePaths = []
    }
  }

  log.info(`Extracted SCR: ${result.skillName} (${result.purposes.length} purposes)`)
  return result as SCR
}

import { describe, expect, test } from "bun:test"
import type { CompletionParams, LLMProvider, LLMResponse, LLMToolResult } from "../../src/providers/types.ts"
import { generateParallelismSection, generateWorkflowDagDocument, runPass3 } from "../../src/compiler/passes/extract-parallelism/parallelism.ts"
import type { TokenUsage } from "../../src/core/types.ts"

class MockProvider implements LLMProvider {
  readonly name = "mock"

  constructor(private readonly text: string) {}

  async complete(_params: CompletionParams): Promise<LLMResponse> {
    return {
      text: this.text,
      toolCalls: [],
      tokens: emptyTokens(),
      durationMs: 1,
      stopReason: "end_turn",
    }
  }

  async completeWithToolResults(
    _params: CompletionParams,
    _toolResults: LLMToolResult[],
    _previousResponse: LLMResponse,
  ): Promise<LLMResponse> {
    throw new Error("not used")
  }
}

function emptyTokens(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

describe("runPass3", () => {
  test("returns no parallelism for a linear workflow", async () => {
    const provider = new MockProvider(JSON.stringify({
      hasParallelism: false,
      reasoning: "The workflow is linear.",
      steps: [],
      parallelGroups: [],
    }))

    const result = await runPass3("# Skill\nDo one thing after another.", provider)
    expect(result.dag.steps).toHaveLength(0)
    expect(result.dag.parallelism).toHaveLength(0)
    expect(generateParallelismSection(result.dag)).toBe("")
  })

  test("builds a compact DAG and sub-agent section for fan-out workflows", async () => {
    const provider = new MockProvider(JSON.stringify({
      hasParallelism: true,
      reasoning: "Research and drafting can happen after initial scoping.",
      steps: [
        { id: "scope-task", description: "Clarify the task scope and required output", primitives: ["reason.planning"], dependsOn: [] },
        { id: "research-inputs", description: "Collect supporting inputs and evidence", primitives: ["tool.exec"], dependsOn: ["scope-task"] },
        { id: "draft-output", description: "Draft the main output structure", primitives: ["reason.planning"], dependsOn: ["scope-task"] },
        { id: "merge-results", description: "Merge the researched facts into the draft", primitives: ["reason.planning"], dependsOn: ["research-inputs", "draft-output"] },
      ],
      parallelGroups: [
        { stepIds: ["research-inputs", "draft-output"], reason: "Both start from the scoped task and join at merge-results." },
      ],
    }))

    const result = await runPass3("# Skill\nScope, research, draft, then merge.", provider)
    expect(result.dag.steps).toHaveLength(4)
    expect(result.dag.parallelism).toHaveLength(1)
    expect(result.dag.parallelism[0]?.type).toBe("tlp")

    const section = generateParallelismSection(result.dag)
    expect(section).toContain("**Parallel execution hints:**")
    expect(section).toContain("TLP")
    expect(section).toContain("sub-agent")
    expect(section).toContain("research-inputs")
    expect(section).toContain("draft-output")

    const workflowDag = generateWorkflowDagDocument(result.dag)
    expect(workflowDag).toContain("## Workflow DAG")
    expect(workflowDag).toContain("```mermaid")
    expect(workflowDag).toContain("scope_task --> research_inputs")
    expect(workflowDag).toContain("scope_task --> draft_output")
  })

  test("emits DLP guidance for a single iterating step", async () => {
    const provider = new MockProvider(JSON.stringify({
      hasParallelism: true,
      reasoning: "The same analysis runs across an independent collection of files.",
      steps: [
        { id: "collect-files", description: "Collect input CSV files", primitives: ["tool.exec"], dependsOn: [] },
        { id: "analyze-each", description: "Run the same analysis on each CSV file", primitives: ["tool.exec"], dependsOn: ["collect-files"] },
        { id: "aggregate", description: "Aggregate per-file results", primitives: ["reason.planning"], dependsOn: ["analyze-each"] },
      ],
      parallelGroups: [
        { type: "dlp", stepIds: ["analyze-each"], mechanism: "xargs -P", reason: "Each CSV is independent." },
      ],
    }))

    const result = await runPass3("# Skill\nAnalyze each CSV.", provider)
    expect(result.dag.parallelism).toHaveLength(1)
    expect(result.dag.parallelism[0]?.type).toBe("dlp")
    expect(result.dag.parallelism[0]?.steps).toEqual(["analyze-each"])

    const section = generateParallelismSection(result.dag)
    expect(section).toContain("DLP")
    expect(section).toContain("xargs -P")
    expect(section).toContain("Promise.all")
  })

  test("emits ILP guidance for independent tool calls in one turn", async () => {
    const provider = new MockProvider(JSON.stringify({
      hasParallelism: true,
      reasoning: "Two independent tool calls can be issued in a single turn.",
      steps: [
        { id: "search-jira", description: "Search Jira for related incidents", primitives: ["tool.exec"], dependsOn: [] },
        { id: "collect-logs", description: "Collect logs from the log service", primitives: ["tool.exec"], dependsOn: [] },
        { id: "correlate", description: "Correlate findings across sources", primitives: ["reason.planning"], dependsOn: ["search-jira", "collect-logs"] },
      ],
      parallelGroups: [
        { type: "ilp", stepIds: ["search-jira", "collect-logs"], mechanism: "batched tool_use", reason: "No data dependency between the two lookups." },
      ],
    }))

    const result = await runPass3("# Skill\nSearch and collect logs.", provider)
    expect(result.dag.parallelism).toHaveLength(1)
    expect(result.dag.parallelism[0]?.type).toBe("ilp")
    expect(result.dag.parallelism[0]?.steps).toEqual(["search-jira", "collect-logs"])

    const section = generateParallelismSection(result.dag)
    expect(section).toContain("ILP")
    expect(section).toContain("single assistant turn")
    expect(section).toContain("batched tool_use")
  })

  test("drops ILP groups with fewer than two steps", async () => {
    const provider = new MockProvider(JSON.stringify({
      hasParallelism: true,
      reasoning: "Bogus single-step ILP.",
      steps: [
        { id: "a", description: "alpha", primitives: ["tool.exec"], dependsOn: [] },
        { id: "b", description: "beta", primitives: ["tool.exec"], dependsOn: ["a"] },
      ],
      parallelGroups: [
        { type: "ilp", stepIds: ["a"], mechanism: "batched tool_use" },
      ],
    }))

    const result = await runPass3("# Skill", provider)
    expect(result.dag.parallelism).toHaveLength(0)
  })
})
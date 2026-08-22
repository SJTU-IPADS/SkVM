import { test, expect, describe } from "bun:test"
import { tmpdir } from "node:os"
import path from "node:path"
import { ConversationLog } from "../../src/core/conversation-logger.ts"
import type { CompletionParams } from "../../src/providers/types.ts"

describe("ConversationLog", () => {
  test("logRequest snapshots messages instead of storing reference", async () => {
    const filePath = path.join(tmpdir(), `conv-test-${Date.now()}.jsonl`)
    const log = new ConversationLog(filePath)

    const messages: Array<{ role: "user" | "assistant"; content: string }> = [
      { role: "user", content: "hello" },
    ]
    const params: CompletionParams = {
      messages,
      system: "test",
      tools: [],
      maxTokens: 1024,
    }

    // First log: 1 message
    log.logRequest(params, "complete")

    // Mutate the array (simulating agent-loop.ts line 172)
    messages.push(
      { role: "assistant", content: "response 1" },
      { role: "user", content: "tool result 1" },
    )

    // Second log: 3 messages
    log.logRequest(params, "completeWithToolResults")

    messages.push(
      { role: "assistant", content: "response 2" },
      { role: "user", content: "tool result 2" },
    )

    // Third log: 5 messages
    log.logRequest(params, "completeWithToolResults")

    await log.finalize()

    const content = await Bun.file(filePath).text()
    const entries = content.trim().split("\n").map((line) => JSON.parse(line))

    const requestEntries = entries.filter((e: { type: string }) => e.type === "request")
    expect(requestEntries).toHaveLength(3)
    expect(requestEntries[0].messages).toHaveLength(1)
    expect(requestEntries[1].messages).toHaveLength(3)
    expect(requestEntries[2].messages).toHaveLength(5)
  })
})

describe("ConversationLog serving backend", () => {
  const baseResponse = {
    text: "hi",
    toolCalls: [],
    tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    durationMs: 1,
    stopReason: "end_turn" as const,
  }

  test("records the fleet that served a call, and omits it when unreported", async () => {
    const filePath = path.join(tmpdir(), `conv-fleet-${Date.now()}.jsonl`)
    const log = new ConversationLog(filePath)

    log.logResponse({ ...baseResponse, servingProvider: "DeepInfra" })
    log.logResponse(baseResponse)
    await log.finalize()

    const entries = (await Bun.file(filePath).text())
      .trim().split("\n").map((line) => JSON.parse(line))

    // A serving path that never reaches the transcript is not diagnosable after the fact.
    expect(entries[0].servingProvider).toBe("DeepInfra")
    expect("servingProvider" in entries[1]).toBe(false)
  })
})

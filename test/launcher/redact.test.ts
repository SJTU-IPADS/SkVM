import { test, expect, describe } from "bun:test"
import { redactSecretToken } from "../../src/launcher/index.ts"

describe("redactSecretToken", () => {
  test("redacts injected route key values", () => {
    expect(redactSecretToken("SKVM_ROUTE_openai_KEY=sk-abc123")).toBe("SKVM_ROUTE_openai_KEY=<redacted>")
  })

  test("redacts generic secret-looking env names", () => {
    expect(redactSecretToken("OPENAI_API_KEY=sk-x")).toBe("OPENAI_API_KEY=<redacted>")
    expect(redactSecretToken("MY_TOKEN=t")).toBe("MY_TOKEN=<redacted>")
    expect(redactSecretToken("DB_PASSWORD=p")).toBe("DB_PASSWORD=<redacted>")
  })

  test("leaves non-secret tokens untouched", () => {
    expect(redactSecretToken("HOME=/workspace")).toBe("HOME=/workspace")
    expect(redactSecretToken("--network=bridge")).toBe("--network=bridge")
    expect(redactSecretToken("-e")).toBe("-e")
    expect(redactSecretToken("ghcr.io/sjtu-ipads/skvm-sandbox:0.1.4")).toBe("ghcr.io/sjtu-ipads/skvm-sandbox:0.1.4")
  })

  test("redacts the entire value even when it contains '='", () => {
    expect(redactSecretToken("SKVM_ROUTE_x_KEY=sk-a=b=c")).toBe("SKVM_ROUTE_x_KEY=<redacted>")
  })
})

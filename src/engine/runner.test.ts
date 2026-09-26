import { describe, expect, it } from "vitest"

import type { TrialNode } from "../dsl/types"
import { ManualFrameSource } from "./frameSource"
import { TrialRunner } from "./runner"

function waitTrial(allowedKeys: string[]): TrialNode {
  return {
    type: "trial",
    id: "t",
    phases: [
      { type: "fixation", duration: 100 },
      { type: "stimulus", duration: "untilResponse" },
    ],
    response: { allowedKeys, timeoutMs: 60000, acceptInPhases: [1] },
    next: "end",
  }
}

async function respond(allowedKeys: string[], key: string) {
  const source = new ManualFrameSource()
  const runner = new TrialRunner(source, 60)
  const promise = runner.runTrial(waitTrial(allowedKeys))
  for (let i = 0; i < 10; i++) source.advance(1000 / 60)
  runner.submitInput({ key, timestamp: source.now() })
  // An ignored key leaves the untilResponse phase open, so the promise
  // would never settle; race against a sentinel instead of hanging.
  return Promise.race([promise, Promise.resolve("still-waiting" as const)])
}

describe("TrialRunner key matching", () => {
  it("accepts an uppercase letter (Caps Lock / Shift) and records the configured key", async () => {
    const result = await respond(["a", "b"], "A")
    expect(result).not.toBe("still-waiting")
    if (result === "still-waiting") return
    expect(result.response).toBe("a")
    expect(result.timedOut).toBe(false)
  })

  it("still ignores keys that are not allowed", async () => {
    expect(await respond(["a", "b"], "c")).toBe("still-waiting")
  })

  it("does not case-fold multi-character keys", async () => {
    expect(await respond(["Enter"], "enter")).toBe("still-waiting")
  })
})

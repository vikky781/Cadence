import { describe, expect, it } from "vitest"

import { ManualFrameSource } from "../engine"
import { runCalibration } from "./calibration"

describe("runCalibration", () => {
  it("resolves with the expected sample count and refresh rate after exactly sampleFrames + 1 advances", async () => {
    const source = new ManualFrameSource()

    // runCalibration() runs synchronously up through FrameClock.start()'s
    // first requestFrame() call (it returns `new Promise((resolve) => {...})`
    // directly, with no `await` before start() runs), so by the time this
    // call returns, ManualFrameSource already has the first callback queued.
    // It is therefore safe to drive all advance() calls synchronously right
    // after invoking runCalibration(), before awaiting its result.
    const promise = runCalibration(source, { sampleFrames: 10 })

    // 1 "wasted" advance for the first frame (whose interval is null and is
    // skipped), then 10 more advances to collect exactly 10 intervals.
    for (let i = 0; i < 11; i++) {
      source.advance(16.667)
    }

    const result = await promise

    expect(result.sampleCount).toBe(10)
    expect(Math.abs(result.refreshHz - 60)).toBeLessThan(0.5)
    expect(result.jitterSdMs).toBeLessThan(0.01)
  })

  it("surfaces clockResolutionMs as a non-negative number", async () => {
    const source = new ManualFrameSource()

    const promise = runCalibration(source, { sampleFrames: 5 })
    for (let i = 0; i < 6; i++) {
      source.advance(16.667)
    }

    const result = await promise

    expect(typeof result.clockResolutionMs).toBe("number")
    expect(result.clockResolutionMs).toBeGreaterThanOrEqual(0)
  })
})

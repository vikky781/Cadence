import { describe, expect, it } from "vitest"

import {
  estimateRefreshRate,
  isDroppedFrame,
  measureClockResolutionMs,
} from "./frameStats"

function makeArrayNowFn(values: number[]): () => number {
  let index = 0
  return () => {
    const value = values[Math.min(index, values.length - 1)]
    index += 1
    return value
  }
}

describe("estimateRefreshRate", () => {
  it("estimates ~60Hz with near-zero jitter for ten identical 16.667ms intervals", () => {
    const intervals = Array.from({ length: 10 }, () => 16.667)

    const result = estimateRefreshRate(intervals)

    expect(Math.abs(result.refreshHz - 60)).toBeLessThan(0.5)
    expect(result.jitterSdMs).toBeLessThan(0.01)
    expect(result.sampleCount).toBe(10)
  })

  it("throws on an empty array", () => {
    expect(() => estimateRefreshRate([])).toThrow()
  })

  it("computes the median correctly for odd- and even-length arrays", () => {
    // Odd length: [10, 20, 30] sorted -> middle element is 20.
    expect(estimateRefreshRate([10, 20, 30]).medianIntervalMs).toBe(20)

    // Even length: [10, 20, 30, 40] sorted -> average of the two middle
    // elements, (20 + 30) / 2 = 25.
    expect(estimateRefreshRate([10, 20, 30, 40]).medianIntervalMs).toBe(25)
  })
})

describe("isDroppedFrame", () => {
  it("flags an interval more than 1.5x the median as dropped", () => {
    expect(isDroppedFrame(30, 16.667)).toBe(true)
  })

  it("does not flag an interval close to the median as dropped", () => {
    expect(isDroppedFrame(17, 16.667)).toBe(false)
  })
})

describe("measureClockResolutionMs", () => {
  it("returns the median of the observed nonzero deltas", () => {
    // Sequence: 0,0,0,0.1,0.1,0.2,0.2,0.2,0.3 then repeats 0.3.
    // Nonzero consecutive deltas: 0.1 (0->0.1), 0.1 (0.1->0.2), 0.1 (0.2->0.3).
    // All later repeats of 0.3 produce a delta of 0, which is ignored.
    // Median of [0.1, 0.1, 0.1] is 0.1.
    const nowFn = makeArrayNowFn([0, 0, 0, 0.1, 0.1, 0.2, 0.2, 0.2, 0.3])

    expect(measureClockResolutionMs(nowFn)).toBeCloseTo(0.1, 10)
  })

  it("returns 0 when nowFn always returns the same constant", () => {
    const nowFn = () => 42

    expect(measureClockResolutionMs(nowFn)).toBe(0)
  })
})

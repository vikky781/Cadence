import { describe, expect, it } from "vitest"

import { FrameClock, type FrameRecord } from "./frameClock"
import { ManualFrameSource } from "./frameSource"

describe("FrameClock", () => {
  it("produces one onFrame call per advance(), with increasing frameIndex and timestamps", () => {
    const source = new ManualFrameSource()
    const clock = new FrameClock(source)
    const records: FrameRecord[] = []

    clock.start((record) => records.push(record))

    source.advance(16.667)
    source.advance(16.667)
    source.advance(16.667)

    expect(records).toHaveLength(3)
    expect(records.map((r) => r.frameIndex)).toEqual([0, 1, 2])
    expect(records[0].timestamp).toBeLessThan(records[1].timestamp)
    expect(records[1].timestamp).toBeLessThan(records[2].timestamp)
  })

  it("has a null interval on the first frame and true timestamp deltas afterward", () => {
    const source = new ManualFrameSource()
    const clock = new FrameClock(source)
    const records: FrameRecord[] = []

    clock.start((record) => records.push(record))

    source.advance(16.667)
    source.advance(20)
    source.advance(15)

    expect(records[0].interval).toBeNull()
    expect(records[1].interval).toBeCloseTo(records[1].timestamp - records[0].timestamp, 6)
    expect(records[2].interval).toBeCloseTo(records[2].timestamp - records[1].timestamp, 6)
  })

  it("stop() prevents any further onFrame calls, even after later advance()s", () => {
    const source = new ManualFrameSource()
    const clock = new FrameClock(source)
    const records: FrameRecord[] = []

    clock.start((record) => records.push(record))
    source.advance(16.667)
    expect(records).toHaveLength(1)

    clock.stop()
    source.advance(16.667)
    source.advance(16.667)

    expect(records).toHaveLength(1)
  })

  it("throws if start() is called a second time without an intervening stop()", () => {
    const source = new ManualFrameSource()
    const clock = new FrameClock(source)

    clock.start(() => {})

    expect(() => clock.start(() => {})).toThrow()
  })

  it("isRunning() reflects start()/stop() state", () => {
    const source = new ManualFrameSource()
    const clock = new FrameClock(source)

    expect(clock.isRunning()).toBe(false)

    clock.start(() => {})
    expect(clock.isRunning()).toBe(true)

    clock.stop()
    expect(clock.isRunning()).toBe(false)
  })
})

import { describe, expect, it, vi } from "vitest"

import { ManualFrameSource } from "./frameSource"

describe("ManualFrameSource", () => {
  it("invokes a queued callback exactly once with the new currentTime on advance()", () => {
    const source = new ManualFrameSource()
    const callback = vi.fn()

    source.requestFrame(callback)
    source.advance(16.667)

    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith(16.667)
  })

  it("invokes all callbacks queued before one advance() with the same new timestamp", () => {
    const source = new ManualFrameSource()
    const callbackA = vi.fn()
    const callbackB = vi.fn()
    const callbackC = vi.fn()

    source.requestFrame(callbackA)
    source.requestFrame(callbackB)
    source.requestFrame(callbackC)

    const results = source.advance(10)

    expect(callbackA).toHaveBeenCalledWith(10)
    expect(callbackB).toHaveBeenCalledWith(10)
    expect(callbackC).toHaveBeenCalledWith(10)
    expect(results).toEqual([10, 10, 10])
  })

  it("does not invoke a self-requeued callback again within the same advance()", () => {
    const source = new ManualFrameSource()
    let callCount = 0

    const callback = () => {
      callCount += 1
      source.requestFrame(callback)
    }

    source.requestFrame(callback)
    const firstResults = source.advance(16.667)

    expect(callCount).toBe(1)
    expect(firstResults).toEqual([16.667])

    const secondResults = source.advance(16.667)

    expect(callCount).toBe(2)
    expect(secondResults).toEqual([33.334])
  })

  it("cancelFrame removes a queued callback so it does not fire", () => {
    const source = new ManualFrameSource()
    const callback = vi.fn()

    const handle = source.requestFrame(callback)
    source.cancelFrame(handle)
    source.advance(16.667)

    expect(callback).not.toHaveBeenCalled()
  })

  it("now() reflects currentTime starting from 0 and after advances", () => {
    const source = new ManualFrameSource()

    expect(source.now()).toBe(0)

    source.advance(5)
    expect(source.now()).toBe(5)

    source.advance(2.5)
    expect(source.now()).toBe(7.5)
  })

  it("getPendingCount() reflects pending callbacks before and after advance()/cancelFrame()", () => {
    const source = new ManualFrameSource()

    expect(source.getPendingCount()).toBe(0)

    const handleA = source.requestFrame(() => {})
    source.requestFrame(() => {})
    expect(source.getPendingCount()).toBe(2)

    source.cancelFrame(handleA)
    expect(source.getPendingCount()).toBe(1)

    source.advance(16.667)
    expect(source.getPendingCount()).toBe(0)
  })
})

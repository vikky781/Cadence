import { afterEach, describe, expect, it, vi } from "vitest"

import type { CalibrationResult } from "./calibration"
import { collectDeviceInfo, evaluateDeviceGate } from "./diagnostics"

function makeCalibration(overrides: Partial<CalibrationResult> = {}): CalibrationResult {
  return {
    refreshHz: 60,
    medianIntervalMs: 16.667,
    jitterSdMs: 0.1,
    sampleCount: 120,
    clockResolutionMs: 0.1,
    ...overrides,
  }
}

describe("collectDeviceInfo", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("returns correctly-typed fields under jsdom's default test environment", () => {
    const info = collectDeviceInfo()

    expect(typeof info.userAgent).toBe("string")
    expect(typeof info.screenWidth).toBe("number")
    expect(typeof info.screenHeight).toBe("number")
    expect(typeof info.devicePixelRatio).toBe("number")
    expect(typeof info.language).toBe("string")
    expect(["fine", "coarse", "unknown"]).toContain(info.pointerType)
  })

  it("does not throw when window.matchMedia is stubbed as undefined, falling back to pointerType 'unknown'", () => {
    vi.stubGlobal("matchMedia", undefined)

    expect(() => collectDeviceInfo()).not.toThrow()
    expect(collectDeviceInfo().pointerType).toBe("unknown")
  })
})

describe("evaluateDeviceGate", () => {
  it("passes with no reasons when refresh rate and jitter are both within bounds", () => {
    const result = evaluateDeviceGate(makeCalibration(), 50)

    expect(result).toEqual({ pass: true, reasons: [] })
  })

  it("fails with exactly one reason when only refreshHz is below the minimum", () => {
    const calibration = makeCalibration({ refreshHz: 30, jitterSdMs: 0.1 })

    const result = evaluateDeviceGate(calibration, 50)

    expect(result.pass).toBe(false)
    expect(result.reasons).toHaveLength(1)
  })

  it("fails with exactly one reason when only jitter exceeds the threshold", () => {
    const calibration = makeCalibration({ refreshHz: 60, jitterSdMs: 10 })

    const result = evaluateDeviceGate(calibration, 50)

    expect(result.pass).toBe(false)
    expect(result.reasons).toHaveLength(1)
  })

  it("fails with exactly two reasons when both conditions fail simultaneously", () => {
    const calibration = makeCalibration({ refreshHz: 30, jitterSdMs: 10 })

    const result = evaluateDeviceGate(calibration, 50)

    expect(result.pass).toBe(false)
    expect(result.reasons).toHaveLength(2)
  })
})

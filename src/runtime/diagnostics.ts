import type { CalibrationResult } from "./calibration"

export interface DeviceInfo {
  userAgent: string
  screenWidth: number
  screenHeight: number
  devicePixelRatio: number
  pointerType: "fine" | "coarse" | "unknown"
  language: string
}

function tryRead<T>(read: () => T, fallback: T): T {
  try {
    return read()
  } catch {
    return fallback
  }
}

export function collectDeviceInfo(): DeviceInfo {
  const userAgent = tryRead(() => navigator.userAgent, "")
  const screenWidth = tryRead(() => screen.width, 0)
  const screenHeight = tryRead(() => screen.height, 0)
  const devicePixelRatio = tryRead(() => window.devicePixelRatio, 0)
  const language = tryRead(() => navigator.language, "")

  const pointerType = tryRead<"fine" | "coarse" | "unknown">(() => {
    if (typeof window.matchMedia !== "function") return "unknown"
    if (window.matchMedia("(pointer: coarse)").matches) return "coarse"
    if (window.matchMedia("(pointer: fine)").matches) return "fine"
    return "unknown"
  }, "unknown")

  return { userAgent, screenWidth, screenHeight, devicePixelRatio, pointerType, language }
}

export interface DeviceGateResult {
  pass: boolean
  reasons: string[]
}

export function evaluateDeviceGate(
  calibration: CalibrationResult,
  minRefreshHz: number,
): DeviceGateResult {
  const reasons: string[] = []

  if (calibration.refreshHz < minRefreshHz) {
    reasons.push(
      `Measured refresh rate ${calibration.refreshHz.toFixed(2)}Hz is below the required minimum of ${minRefreshHz}Hz.`,
    )
  }

  // This 50%-of-frame-period threshold is this module's own fixed definition
  // of "extreme" jitter -- a judgment call baked into the code, not a value
  // taken from any external benchmark or standard.
  if (calibration.jitterSdMs > 0.5 * calibration.medianIntervalMs) {
    reasons.push(
      `Extreme frame-timing jitter: measured jitter of ${calibration.jitterSdMs.toFixed(2)}ms against a frame period of ${calibration.medianIntervalMs.toFixed(2)}ms.`,
    )
  }

  return { pass: reasons.length === 0, reasons }
}

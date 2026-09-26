import { FrameClock, estimateRefreshRate, measureClockResolutionMs } from "../engine"
import type { FrameSource } from "../engine"

export interface CalibrationResult {
  refreshHz: number
  medianIntervalMs: number
  jitterSdMs: number
  sampleCount: number
  clockResolutionMs: number
}

export function runCalibration(
  frameSource: FrameSource,
  options?: { sampleFrames?: number },
): Promise<CalibrationResult> {
  const sampleFrames = options?.sampleFrames ?? 120
  const clockResolutionMs = measureClockResolutionMs(() => frameSource.now())

  return new Promise<CalibrationResult>((resolve) => {
    const clock = new FrameClock(frameSource)
    const intervals: number[] = []

    clock.start((record) => {
      if (record.interval === null) return

      intervals.push(record.interval)
      if (intervals.length >= sampleFrames) {
        // Cleanup here only covers the happy path: there is no cancellation
        // token for an abandoned calibration in this version. That's an
        // accepted scope cut for now, not an oversight.
        clock.stop()
        resolve({ ...estimateRefreshRate(intervals), clockResolutionMs })
      }
    })
  })
}

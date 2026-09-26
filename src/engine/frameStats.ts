export interface RefreshEstimate {
  refreshHz: number
  medianIntervalMs: number
  jitterSdMs: number
  sampleCount: number
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

export function estimateRefreshRate(intervals: number[]): RefreshEstimate {
  if (intervals.length === 0) {
    throw new Error("estimateRefreshRate requires at least one interval")
  }

  const medianIntervalMs = median(intervals)
  const refreshHz = 1000 / medianIntervalMs

  const mean = intervals.reduce((sum, value) => sum + value, 0) / intervals.length
  // Population standard deviation (divide by N, not N-1): intervals is the
  // complete observed sample we're describing, not a smaller sample used to
  // estimate a larger population, so Bessel's correction does not apply.
  const variance =
    intervals.reduce((sum, value) => sum + (value - mean) ** 2, 0) / intervals.length
  const jitterSdMs = Math.sqrt(variance)

  return {
    refreshHz,
    medianIntervalMs,
    jitterSdMs,
    sampleCount: intervals.length,
  }
}

export function isDroppedFrame(interval: number, medianIntervalMs: number): boolean {
  return interval > 1.5 * medianIntervalMs
}

export function measureClockResolutionMs(nowFn: () => number, samples = 2000): number {
  const deltas: number[] = []
  let previous = nowFn()

  for (let i = 1; i < samples; i++) {
    const current = nowFn()
    const delta = current - previous
    if (delta > 0) {
      deltas.push(delta)
    }
    previous = current
  }

  if (deltas.length === 0) {
    return 0
  }

  return median(deltas)
}

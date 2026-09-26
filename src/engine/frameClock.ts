import type { FrameSource } from "./frameSource"

export interface FrameRecord {
  frameIndex: number
  timestamp: number
  interval: number | null
}

export class FrameClock {
  private readonly frameSource: FrameSource
  private running = false
  private handle: number | null = null
  private frameIndex = 0
  private previousTimestamp: number | null = null

  constructor(frameSource: FrameSource) {
    this.frameSource = frameSource
  }

  start(onFrame: (record: FrameRecord) => void): void {
    if (this.running) {
      throw new Error("FrameClock.start() was called while already running; call stop() first.")
    }

    this.running = true
    this.frameIndex = 0
    this.previousTimestamp = null

    const tick = (timestamp: number) => {
      const interval =
        this.previousTimestamp === null ? null : timestamp - this.previousTimestamp
      const record: FrameRecord = {
        frameIndex: this.frameIndex,
        timestamp,
        interval,
      }

      this.previousTimestamp = timestamp
      this.frameIndex += 1

      onFrame(record)

      this.handle = this.frameSource.requestFrame(tick)
    }

    this.handle = this.frameSource.requestFrame(tick)
  }

  stop(): void {
    if (this.handle !== null) {
      this.frameSource.cancelFrame(this.handle)
      this.handle = null
    }
    this.running = false
  }

  now(): number {
    return this.frameSource.now()
  }

  isRunning(): boolean {
    return this.running
  }
}

export interface FrameSource {
  now(): number
  requestFrame(callback: (timestamp: number) => void): number
  cancelFrame(handle: number): void
}

export class BrowserFrameSource implements FrameSource {
  constructor() {
    if (typeof globalThis.requestAnimationFrame !== "function") {
      throw new Error(
        "BrowserFrameSource requires globalThis.requestAnimationFrame, which is not available in this environment.",
      )
    }
  }

  now(): number {
    return globalThis.performance.now()
  }

  requestFrame(callback: (timestamp: number) => void): number {
    return globalThis.requestAnimationFrame(callback)
  }

  cancelFrame(handle: number): void {
    globalThis.cancelAnimationFrame(handle)
  }
}

export class ManualFrameSource implements FrameSource {
  private currentTime = 0
  private pending = new Map<number, (timestamp: number) => void>()
  private nextHandle = 1

  requestFrame(callback: (timestamp: number) => void): number {
    const handle = this.nextHandle++
    this.pending.set(handle, callback)
    return handle
  }

  cancelFrame(handle: number): void {
    this.pending.delete(handle)
  }

  now(): number {
    return this.currentTime
  }

  advance(deltaMs: number): number[] {
    this.currentTime += deltaMs

    const callbacks = [...this.pending.values()]
    this.pending.clear()

    const results: number[] = []
    for (const callback of callbacks) {
      callback(this.currentTime)
      results.push(this.currentTime)
    }
    return results
  }

  getPendingCount(): number {
    return this.pending.size
  }
}

import type { Phase } from "../dsl/types"
import type { FrameRecord } from "./frameClock"
import { isDroppedFrame } from "./frameStats"

export function durationToFrames(durationMs: number, refreshHz: number): number {
  const frames = Math.round(durationMs / (1000 / refreshHz))
  return Math.max(1, frames)
}

export interface PhaseTimingRecord {
  phaseIndex: number
  requestedDurationMs: number | "untilResponse"
  targetFrames: number | null
  onsetFrameTimestamp: number
  onsetFrameIndex: number
  achievedFrames: number
  droppedFramesDuringPhase: number
}

export class PhaseSchedulerError extends Error {}

export class PhaseScheduler {
  private readonly phases: Phase[]
  private readonly refreshHz: number
  private readonly targetFramesByPhase: (number | null)[]

  private currentPhaseIndex = -1
  private framesElapsedInCurrentPhase = 0
  private droppedFramesInCurrentPhase = 0
  private onsetFrameTimestamp = 0
  private onsetFrameIndex = 0
  private readonly completedRecords: PhaseTimingRecord[] = []

  constructor(phases: Phase[], refreshHz: number) {
    if (phases.length === 0) {
      throw new PhaseSchedulerError("PhaseScheduler requires at least one phase.")
    }

    this.phases = phases
    this.refreshHz = refreshHz
    this.targetFramesByPhase = phases.map((phase) =>
      phase.duration === "untilResponse" ? null : durationToFrames(phase.duration, refreshHz),
    )
  }

  onFrame(record: FrameRecord): {
    phaseChanged: boolean
    currentPhaseIndex: number
    isComplete: boolean
    completedPhaseRecord: PhaseTimingRecord | null
  } {
    if (this.currentPhaseIndex === -1) {
      this.currentPhaseIndex = 0
      this.onsetFrameTimestamp = record.timestamp
      this.onsetFrameIndex = record.frameIndex
      this.framesElapsedInCurrentPhase = 1
      this.droppedFramesInCurrentPhase = 0

      return {
        phaseChanged: true,
        currentPhaseIndex: 0,
        isComplete: false,
        completedPhaseRecord: null,
      }
    }

    this.framesElapsedInCurrentPhase += 1
    if (record.interval !== null && isDroppedFrame(record.interval, 1000 / this.refreshHz)) {
      this.droppedFramesInCurrentPhase += 1
    }

    const targetFrames = this.targetFramesByPhase[this.currentPhaseIndex]

    if (targetFrames === null) {
      return {
        phaseChanged: false,
        currentPhaseIndex: this.currentPhaseIndex,
        isComplete: false,
        completedPhaseRecord: null,
      }
    }

    if (this.framesElapsedInCurrentPhase < targetFrames) {
      return {
        phaseChanged: false,
        currentPhaseIndex: this.currentPhaseIndex,
        isComplete: false,
        completedPhaseRecord: null,
      }
    }

    const completedRecord = this.finalizeCurrentPhase(targetFrames)

    const hasNextPhase = this.currentPhaseIndex + 1 < this.phases.length
    if (hasNextPhase) {
      this.currentPhaseIndex += 1
      this.onsetFrameTimestamp = record.timestamp
      this.onsetFrameIndex = record.frameIndex
      this.framesElapsedInCurrentPhase = 1
      this.droppedFramesInCurrentPhase = 0

      return {
        phaseChanged: true,
        currentPhaseIndex: this.currentPhaseIndex,
        isComplete: false,
        completedPhaseRecord: completedRecord,
      }
    }

    return {
      phaseChanged: false,
      currentPhaseIndex: this.currentPhaseIndex,
      isComplete: true,
      completedPhaseRecord: completedRecord,
    }
  }

  endCurrentPhase(): PhaseTimingRecord {
    const targetFrames = this.targetFramesByPhase[this.currentPhaseIndex]
    if (targetFrames !== null) {
      throw new PhaseSchedulerError(
        `endCurrentPhase() was called on phase ${this.currentPhaseIndex}, which is not an "untilResponse" phase.`,
      )
    }

    return this.finalizeCurrentPhase(null)
  }

  getCompletedRecords(): PhaseTimingRecord[] {
    return [...this.completedRecords]
  }

  getCurrentPhaseIndex(): number {
    return this.currentPhaseIndex
  }

  private finalizeCurrentPhase(targetFrames: number | null): PhaseTimingRecord {
    const record: PhaseTimingRecord = {
      phaseIndex: this.currentPhaseIndex,
      requestedDurationMs: this.phases[this.currentPhaseIndex].duration,
      targetFrames,
      onsetFrameTimestamp: this.onsetFrameTimestamp,
      onsetFrameIndex: this.onsetFrameIndex,
      achievedFrames: this.framesElapsedInCurrentPhase,
      droppedFramesDuringPhase: this.droppedFramesInCurrentPhase,
    }
    this.completedRecords.push(record)
    return record
  }
}

import type { TrialNode } from "../dsl/types"
import { FrameClock } from "./frameClock"
import type { FrameSource } from "./frameSource"
import { PhaseScheduler, type PhaseTimingRecord } from "./phaseScheduler"

export interface InputEvent {
  key: string
  timestamp: number
}

export interface TrialRunResult {
  phaseRecords: PhaseTimingRecord[]
  response: string | null
  responseTimestamp: number | null
  reactionTimeMs: number | null
  timedOut: boolean
}

export class TrialRunner {
  private readonly frameClock: FrameClock
  private readonly refreshHz: number

  private phaseScheduler: PhaseScheduler | null = null
  private trialNode: TrialNode | null = null
  private acceptInPhases: number[] = []
  private currentPhaseOnsetTimestamp = 0
  private response: string | null = null
  private responseTimestamp: number | null = null
  private reactionTimeMs: number | null = null
  private resolveTrial: ((result: TrialRunResult) => void) | null = null

  constructor(frameSource: FrameSource, refreshHz: number) {
    this.frameClock = new FrameClock(frameSource)
    this.refreshHz = refreshHz
  }

  runTrial(
    trialNode: TrialNode,
    onPhaseChange?: (phaseIndex: number) => void,
  ): Promise<TrialRunResult> {
    this.trialNode = trialNode
    this.acceptInPhases = trialNode.response?.acceptInPhases ?? []
    this.currentPhaseOnsetTimestamp = 0
    this.response = null
    this.responseTimestamp = null
    this.reactionTimeMs = null

    const phaseScheduler = new PhaseScheduler(trialNode.phases, this.refreshHz)
    this.phaseScheduler = phaseScheduler

    return new Promise<TrialRunResult>((resolve) => {
      this.resolveTrial = resolve

      this.frameClock.start((record) => {
        const result = phaseScheduler.onFrame(record)

        if (result.phaseChanged) {
          this.currentPhaseOnsetTimestamp = record.timestamp
          onPhaseChange?.(result.currentPhaseIndex)
        }

        if (result.isComplete) {
          this.finishTrial()
        }
      })
    })
  }

  submitInput(event: InputEvent): void {
    if (!this.trialNode || !this.phaseScheduler || this.response !== null) return

    const response = this.trialNode.response
    if (!response) return

    const currentPhaseIndex = this.phaseScheduler.getCurrentPhaseIndex()
    if (!this.acceptInPhases.includes(currentPhaseIndex)) return
    if (!response.allowedKeys.includes(event.key)) return

    // timeoutMs is treated as informational only in this version: the
    // response phase's own duration (fixed frame count, or "untilResponse")
    // is what actually governs how long input is accepted. We do not run a
    // second independent timer to reconcile a mismatch between timeoutMs
    // and the phase's duration -- the DSL author/linter are expected to
    // keep those in sync. That reconciliation is an explicit scope cut.

    this.response = event.key
    this.responseTimestamp = event.timestamp
    this.reactionTimeMs = event.timestamp - this.currentPhaseOnsetTimestamp

    const currentPhase = this.trialNode.phases[currentPhaseIndex]
    if (currentPhase.duration === "untilResponse") {
      this.phaseScheduler.endCurrentPhase()
      this.finishTrial()
    }
  }

  getResponse(): string | null {
    return this.response
  }

  private finishTrial(): void {
    if (!this.phaseScheduler || !this.resolveTrial) return

    this.frameClock.stop()

    const result: TrialRunResult = {
      phaseRecords: this.phaseScheduler.getCompletedRecords(),
      response: this.response,
      responseTimestamp: this.responseTimestamp,
      reactionTimeMs: this.reactionTimeMs,
      timedOut: this.response === null,
    }

    const resolve = this.resolveTrial
    this.resolveTrial = null
    resolve(result)
  }
}

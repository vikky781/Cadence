import { useEffect, useRef, useState } from "react"

import { ExperimentSchema, evaluateExpression, type Experiment, type Node, type Phase } from "../dsl"
import { BrowserFrameSource, TrialRunner, bufferTrial } from "../engine"
import { SeededRandom } from "../engine/rng"
import { expandBlock, shouldBreakAfter } from "../engine/scheduler"
import {
  Presenter,
  createSession,
  ensureAnonymousSession,
  getSupabaseClient,
  markSessionAbandoned,
  markSessionComplete,
  runCalibration,
  startUploadQueue,
  type UploadQueueHandle,
} from "../runtime"

type TrialNode = Extract<Node, { type: "trial" }>
type BlockNode = Extract<Node, { type: "block" }>
type EndNode = Extract<Node, { type: "end" }>
type Row = Record<string, string | number>

interface TrialContext {
  row: Row | null
  blockId: string | null
  practice: boolean
  rowIndex: number | null
  repetitionIndex: number | null
  blockCorrect: number
  blockAnswered: number
}

function drawPhase(presenter: Presenter, phase: Phase, row: Row | null): void {
  if (phase.content?.kind === "text") {
    presenter.drawText(phase.content.value)
    return
  }
  // Block trials fill "column" content from the current row, e.g. the
  // stimulus text for this trial.
  if (phase.content?.kind === "column" && row && phase.content.value in row) {
    presenter.drawText(String(row[phase.content.value]))
    return
  }
  if (phase.type === "fixation") {
    presenter.drawFixation()
    return
  }
  presenter.drawBlank()
}

export default function RunExperiment() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const presenterRef = useRef<Presenter | null>(null)
  const runnerRef = useRef<TrialRunner | null>(null)

  const initStartedRef = useRef(false)
  const experimentRef = useRef<Experiment | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const currentNodeRef = useRef<Node | null>(null)
  const queueRef = useRef<UploadQueueHandle | null>(null)
  const sequenceRef = useRef(0)
  const refreshHzRef = useRef<number | null>(null)
  const declinedRef = useRef(false)
  const seedRef = useRef<string>("")
  const breakResolveRef = useRef<(() => void) | null>(null)
  const lastTrialRef = useRef<{ response: string | null; rt: number | null; correct: boolean | null }>({
    response: null,
    rt: null,
    correct: null,
  })

  const [sessionId, setSessionId] = useState<string | null>(null)
  const [currentNode, setCurrentNode] = useState<Node | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [breakInfo, setBreakInfo] = useState<{ done: number; total: number } | null>(null)

  useEffect(() => {
    if (!sessionId) return
    const queue = startUploadQueue(sessionId)
    queueRef.current = queue
    return () => {
      queue()
      queueRef.current = null
    }
  }, [sessionId])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const presenter = new Presenter(canvas)
    presenter.drawBlank()
    presenterRef.current = presenter

    const onResize = () => presenter.resize()
    window.addEventListener("resize", onResize)

    const onKeyDown = (e: KeyboardEvent) => {
      const node = currentNodeRef.current
      if (!node || e.repeat) return

      if (breakResolveRef.current) {
        if (e.key === " ") {
          e.preventDefault()
          breakResolveRef.current()
        }
        return
      }
      if (node.type === "trial" || node.type === "block") {
        if (e.key === " ") e.preventDefault()
        runnerRef.current?.submitInput({ key: e.key, timestamp: performance.now() })
      } else if (node.type === "instructions" && node.advanceBy === "key") {
        e.preventDefault()
        void enterNode(node.next)
      }
    }
    window.addEventListener("keydown", onKeyDown)

    return () => {
      window.removeEventListener("resize", onResize)
      window.removeEventListener("keydown", onKeyDown)
      presenterRef.current = null
    }
    // enterNode only reads refs and stable setters, so it is safe to omit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    // Ref guard: React StrictMode double-invokes effects in development and
    // this must not create two sessions.
    if (initStartedRef.current) return
    initStartedRef.current = true

    void (async () => {
      try {
        const versionId = new URLSearchParams(window.location.search).get("version")
        if (!versionId) throw new Error("Missing ?version=<experiment version id> in the URL.")

        await ensureAnonymousSession()

        const { data, error: fetchError } = await getSupabaseClient()
          .from("experiment_versions")
          .select("dsl")
          .eq("id", versionId)
          .single()
        if (fetchError) throw new Error(`Could not load experiment version: ${fetchError.message}`)

        const experiment = ExperimentSchema.parse(data.dsl)
        // The session seed drives block randomization, so a session's trial
        // order is reproducible from the seed stored with it.
        seedRef.current = crypto.randomUUID()
        const newSessionId = await createSession(versionId, seedRef.current)

        experimentRef.current = experiment
        sessionIdRef.current = newSessionId
        setSessionId(newSessionId)
        await enterNode(experiment.entry)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function enterNode(nodeId: string): Promise<void> {
    try {
      const node = experimentRef.current?.nodes[nodeId]
      if (!node) throw new Error(`Node "${nodeId}" does not exist in this experiment.`)

      currentNodeRef.current = node
      setCurrentNode(node)

      switch (node.type) {
        case "consent":
        case "instructions":
          return
        case "trial":
          await runTrialNode(node)
          return
        case "block":
          await runBlockNode(node)
          return
        case "end":
          await finishAtEnd(node)
          return
        default:
          throw new Error(
            `Unsupported node type "${(node as { type: string }).type}" (node "${nodeId}"): this runtime supports consent, instructions, trial, block, and end nodes only.`,
          )
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function runTrialInstance(node: TrialNode, ctx: TrialContext): Promise<boolean | null> {
    const presenter = presenterRef.current
    const sid = sessionIdRef.current
    const experiment = experimentRef.current
    if (!presenter || !sid || !experiment) throw new Error("Runtime is not ready to run a trial.")

    const frameSource = new BrowserFrameSource()

    // The canvas is hidden between screens; wait a frame for React to show
    // it, then re-measure so the backing store matches its on-screen size.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    presenter.resize()

    // Measure the real display refresh rate once so phase frame counts match
    // the actual monitor rather than assuming 60Hz.
    if (refreshHzRef.current === null) {
      const calibration = await runCalibration(frameSource, { sampleFrames: 30 })
      refreshHzRef.current = Math.round(calibration.refreshHz)
    }
    const refreshHz = refreshHzRef.current

    // Row columns whose names match a declared variable become that
    // variable for this trial (e.g. the row's correctKey).
    const declared = experiment.variables.map((v) => v.name)
    const variables: Record<string, string | number | boolean> = {}
    if (ctx.row) {
      for (const name of declared) if (name in ctx.row) variables[name] = ctx.row[name]
    }
    const last = lastTrialRef.current
    const correctAnswer = node.response?.correctAnswer
    const expected =
      correctAnswer === undefined
        ? undefined
        : evaluateExpression(correctAnswer, declared, {
            trialIndex: sequenceRef.current,
            lastResponse: last.response,
            lastRT: last.rt,
            lastCorrect: last.correct,
            blockAccuracy: ctx.blockAnswered > 0 ? ctx.blockCorrect / ctx.blockAnswered : null,
            variables,
          })

    const runner = new TrialRunner(frameSource, refreshHz)
    runnerRef.current = runner
    const result = await runner.runTrial(node, (phaseIndex) => {
      const phase = node.phases[phaseIndex]
      if (phase.type === "feedback" && expected !== undefined) {
        const response = runner.getResponse()
        if (response === null) presenter.drawText("Too slow")
        else presenter.drawFeedback(String(response) === String(expected))
        return
      }
      drawPhase(presenter, phase, ctx.row)
    })
    runnerRef.current = null
    presenter.drawBlank()

    const correct =
      expected === undefined
        ? null
        : result.response !== null && String(result.response) === String(expected)
    lastTrialRef.current = { response: result.response, rt: result.reactionTimeMs, correct }

    sequenceRef.current += 1
    // Quality flag is hard-coded "good" in this version; computing it from
    // tab-visibility and frame-drop rules is a scope cut not yet wired here.
    await bufferTrial({
      sessionId: sid,
      sequenceNumber: sequenceRef.current,
      nodeId: ctx.blockId ?? node.id,
      stimulusRow: ctx.row,
      response: result.response,
      reactionTimeMs: result.reactionTimeMs,
      correct,
      timingEvidence: {
        refreshHz,
        trialTemplate: node.id,
        practice: ctx.practice,
        rowIndex: ctx.rowIndex,
        repetitionIndex: ctx.repetitionIndex,
        phaseRecords: result.phaseRecords,
        responseTimestamp: result.responseTimestamp,
        timedOut: result.timedOut,
      },
      qualityFlag: "good",
      uploaded: false,
    })

    return correct
  }

  async function runTrialNode(node: TrialNode): Promise<void> {
    await runTrialInstance(node, {
      row: null,
      blockId: null,
      practice: false,
      rowIndex: null,
      repetitionIndex: null,
      blockCorrect: 0,
      blockAnswered: 0,
    })
    await enterNode(node.next)
  }

  async function runBlockNode(block: BlockNode): Promise<void> {
    const template = experimentRef.current?.nodes[block.trialTemplate]
    if (!template || template.type !== "trial") {
      throw new Error(`Block "${block.id}" has no valid trial template ("${block.trialTemplate}").`)
    }

    // Seeded per block so each block's order is independent but reproducible.
    const trials = expandBlock(block, new SeededRandom(`${seedRef.current}:${block.id}`))
    let blockCorrect = 0
    let blockAnswered = 0

    for (let i = 0; i < trials.length; i++) {
      const t = trials[i]
      const correct = await runTrialInstance(template, {
        row: t.row,
        blockId: block.id,
        practice: t.practice,
        rowIndex: t.rowIndex,
        repetitionIndex: t.repetitionIndex,
        blockCorrect,
        blockAnswered,
      })
      if (correct !== null) {
        blockAnswered += 1
        if (correct) blockCorrect += 1
      }
      if (shouldBreakAfter(i, trials.length, block.breakEveryN)) {
        await takeBreak(i + 1, trials.length)
      }
    }

    await enterNode(block.next)
  }

  function takeBreak(done: number, total: number): Promise<void> {
    return new Promise<void>((resolve) => {
      breakResolveRef.current = () => {
        breakResolveRef.current = null
        setBreakInfo(null)
        resolve()
      }
      setBreakInfo({ done, total })
    })
  }

  async function finishAtEnd(_node: EndNode): Promise<void> {
    const sid = sessionIdRef.current
    if (!sid || declinedRef.current) return

    // Upload anything still buffered before marking the session complete.
    await queueRef.current?.flush()
    await markSessionComplete(sid)
    queueRef.current?.()
  }

  // enterNode updates currentNodeRef synchronously before its first await, so
  // a second click from the same (now stale) screen is ignored instead of
  // entering the next node twice (e.g. running the same trial concurrently).
  function advanceFrom(fromNodeId: string, next: string) {
    if (currentNodeRef.current?.id !== fromNodeId) return
    void enterNode(next)
  }

  function decline(fromNodeId: string, declineNodeId: string) {
    if (currentNodeRef.current?.id !== fromNodeId) return
    declinedRef.current = true
    const sid = sessionIdRef.current
    if (sid) {
      markSessionAbandoned(sid).catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      )
    }
    void enterNode(declineNodeId)
  }

  const inTrial =
    (currentNode?.type === "trial" || currentNode?.type === "block") && !error && !breakInfo

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-10 font-sans text-foreground">
      <div className="w-full max-w-xl">
        {error && (
          <div role="alert" className="card border-destructive/40">
            <p className="eyebrow text-destructive">This study could not continue</p>
            <p className="mt-2 text-sm">{error}</p>
          </div>
        )}

        {!error && !currentNode && (
          <p className="eyebrow text-center" aria-live="polite">
            Loading study…
          </p>
        )}

        {!error && currentNode?.type === "consent" && (
          <section className="card flex flex-col gap-6 p-6 sm:p-8">
            <p className="eyebrow">Consent</p>
            <p className="text-lg leading-relaxed whitespace-pre-wrap">{currentNode.markdown}</p>
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => advanceFrom(currentNode.id, currentNode.next)}
              >
                Continue
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => decline(currentNode.id, currentNode.declineNodeId)}
              >
                Decline
              </button>
            </div>
          </section>
        )}

        {!error && currentNode?.type === "instructions" && (
          <section className="card flex flex-col gap-6 p-6 sm:p-8">
            <p className="eyebrow">Instructions</p>
            <p className="text-lg leading-relaxed whitespace-pre-wrap">{currentNode.markdown}</p>
            {currentNode.advanceBy === "button" ? (
              <button
                type="button"
                className="btn btn-primary self-start"
                onClick={() => advanceFrom(currentNode.id, currentNode.next)}
              >
                Continue
              </button>
            ) : (
              <p className="eyebrow">Press any key to continue</p>
            )}
          </section>
        )}

        {!error && breakInfo && (
          <section className="card flex flex-col gap-5 p-6 text-center sm:p-8">
            <p className="eyebrow">Break</p>
            <p className="text-xl font-medium">Take a short rest.</p>
            <p className="font-mono text-sm text-muted-foreground tabular-nums">
              {breakInfo.done} of {breakInfo.total} trials done
            </p>
            <button
              type="button"
              className="btn btn-primary self-center"
              onClick={() => breakResolveRef.current?.()}
            >
              Continue
            </button>
            <p className="eyebrow">or press Space</p>
          </section>
        )}

        {!error && currentNode?.type === "end" && (
          <section className="card flex flex-col gap-2 p-6 text-center sm:p-8">
            <p className="eyebrow">Finished</p>
            <p className="text-xl font-medium" data-testid="end-message">
              {currentNode.message}
            </p>
            <p className="text-sm text-muted-foreground">You can close this tab.</p>
          </section>
        )}
      </div>

      {/* Full-bleed stage during trials, so stimulus size and position are
          fixed to the viewport rather than to the page layout. */}
      <canvas
        ref={canvasRef}
        aria-label="Experiment stimulus"
        className="fixed inset-0 h-dvh w-screen"
        style={{ display: inTrial ? "block" : "none" }}
      />
    </main>
  )
}

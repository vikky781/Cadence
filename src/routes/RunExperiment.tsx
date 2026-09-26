import { useEffect, useRef, useState } from "react"

import { ExperimentSchema, type Experiment, type Node, type Phase } from "../dsl"
import { BrowserFrameSource, TrialRunner, bufferTrial } from "../engine"
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
type EndNode = Extract<Node, { type: "end" }>

function drawPhase(presenter: Presenter, phase: Phase): void {
  if (phase.content?.kind === "text") {
    presenter.drawText(phase.content.value)
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

  const [sessionId, setSessionId] = useState<string | null>(null)
  const [currentNode, setCurrentNode] = useState<Node | null>(null)
  const [error, setError] = useState<string | null>(null)

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

      if (node.type === "trial") {
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
        const newSessionId = await createSession(versionId, crypto.randomUUID())

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
        case "end":
          await finishAtEnd(node)
          return
        default:
          throw new Error(
            `Unsupported node type "${(node as { type: string }).type}" (node "${nodeId}"): this runtime supports consent, instructions, trial, and end nodes only.`,
          )
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function runTrialNode(node: TrialNode): Promise<void> {
    const presenter = presenterRef.current
    const sid = sessionIdRef.current
    if (!presenter || !sid) throw new Error("Runtime is not ready to run a trial.")

    const frameSource = new BrowserFrameSource()

    // The canvas is hidden until a trial node is current; wait a frame for
    // React to show it, then re-measure so the backing store isn't 0x0.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    presenter.resize()

    // Measure the real display refresh rate once so phase frame counts match
    // the actual monitor rather than assuming 60Hz.
    if (refreshHzRef.current === null) {
      const calibration = await runCalibration(frameSource, { sampleFrames: 30 })
      refreshHzRef.current = Math.round(calibration.refreshHz)
    }
    const refreshHz = refreshHzRef.current

    // The keydown handler must not route input to a stale runner.
    const runner = new TrialRunner(frameSource, refreshHz)
    runnerRef.current = runner
    const result = await runner.runTrial(node, (phaseIndex) => {
      drawPhase(presenter, node.phases[phaseIndex])
    })
    runnerRef.current = null
    presenter.drawBlank()

    sequenceRef.current += 1
    // Quality flag is hard-coded "good" in this version; computing it from
    // tab-visibility and frame-drop rules is a scope cut not yet wired here.
    await bufferTrial({
      sessionId: sid,
      sequenceNumber: sequenceRef.current,
      nodeId: node.id,
      stimulusRow: null,
      response: result.response,
      reactionTimeMs: result.reactionTimeMs,
      correct: null,
      timingEvidence: {
        refreshHz,
        phaseRecords: result.phaseRecords,
        responseTimestamp: result.responseTimestamp,
        timedOut: result.timedOut,
      },
      qualityFlag: "good",
      uploaded: false,
    })

    await enterNode(node.next)
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

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 p-6">
      {error && <p className="rounded-md border p-3 text-sm text-destructive">{error}</p>}

      {!error && !currentNode && <p>Loading experiment…</p>}

      {!error && currentNode?.type === "consent" && (
        <section className="flex flex-col gap-3">
          <p className="whitespace-pre-wrap">{currentNode.markdown}</p>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded-md bg-primary px-4 py-2 text-primary-foreground"
              onClick={() => advanceFrom(currentNode.id, currentNode.next)}
            >
              Continue
            </button>
            <button
              type="button"
              className="rounded-md border px-4 py-2"
              onClick={() => decline(currentNode.id, currentNode.declineNodeId)}
            >
              Decline
            </button>
          </div>
        </section>
      )}

      {!error && currentNode?.type === "instructions" && (
        <section className="flex flex-col gap-3">
          <p className="whitespace-pre-wrap">{currentNode.markdown}</p>
          {currentNode.advanceBy === "button" ? (
            <button
              type="button"
              className="self-start rounded-md bg-primary px-4 py-2 text-primary-foreground"
              onClick={() => advanceFrom(currentNode.id, currentNode.next)}
            >
              Continue
            </button>
          ) : (
            <p className="text-sm text-muted-foreground">Press any key to continue.</p>
          )}
        </section>
      )}

      {!error && currentNode?.type === "end" && (
        <p className="text-lg font-medium" data-testid="end-message">
          {currentNode.message}
        </p>
      )}

      <canvas
        ref={canvasRef}
        className="w-full rounded-md border"
        style={{ height: "60vh", display: currentNode?.type === "trial" && !error ? "block" : "none" }}
      />
    </main>
  )
}

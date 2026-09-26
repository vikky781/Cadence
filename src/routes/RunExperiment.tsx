import { useEffect, useRef, useState } from "react"

import { ExperimentSchema, type Node, type Phase } from "../dsl"
import { BrowserFrameSource, TrialRunner, type TrialRunResult } from "../engine"
import { Presenter, ensureAnonymousSession, runCalibration } from "../runtime"

// Parsed at module load so any shape mistake fails loudly immediately.
const experiment = ExperimentSchema.parse({
  schemaVersion: 1,
  experimentId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  version: 1,
  meta: {
    title: "Reaction time smoke test",
    description: "Press SPACE as soon as the stimulus appears.",
    authors: ["Cadence"],
    estimatedMinutes: 1,
  },
  assets: [],
  variables: [],
  entry: "consent-1",
  nodes: {
    "consent-1": {
      type: "consent",
      id: "consent-1",
      markdown: "This is a short reaction-time smoke test. Do you consent to take part?",
      declineNodeId: "end-1",
      next: "trial-1",
    },
    "trial-1": {
      type: "trial",
      id: "trial-1",
      phases: [
        { type: "fixation", duration: 500 },
        {
          type: "stimulus",
          duration: "untilResponse",
          content: { kind: "text", value: "Press SPACE" },
        },
      ],
      response: {
        allowedKeys: [" "],
        timeoutMs: 5000,
        acceptInPhases: [1],
      },
      next: "end-1",
    },
    "end-1": {
      type: "end",
      id: "end-1",
      message: "Thanks for participating!",
    },
  },
})

function getNode<T extends Node["type"]>(id: string, type: T): Extract<Node, { type: T }> {
  const node = experiment.nodes[id]
  if (!node || node.type !== type) {
    throw new Error(`Smoke-test experiment: node "${id}" is not of type "${type}".`)
  }
  return node as Extract<Node, { type: T }>
}

const consentNode = getNode("consent-1", "consent")
const trialNode = getNode("trial-1", "trial")
const endNode = getNode("end-1", "end")

// Module-level so React StrictMode's double-invoked effect doesn't trigger
// two anonymous sign-ins.
let sessionPromise: Promise<string> | null = null

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

type Stage = "consent" | "running" | "done"

export default function RunExperiment() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const presenterRef = useRef<Presenter | null>(null)
  const runnerRef = useRef<TrialRunner | null>(null)

  const [stage, setStage] = useState<Stage>("consent")
  const [sessionStatus, setSessionStatus] = useState("Signing in…")
  const [result, setResult] = useState<TrialRunResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    sessionPromise ??= ensureAnonymousSession()
    sessionPromise.then(
      (userId) => setSessionStatus(`Anonymous session: ${userId}`),
      (err: unknown) =>
        setSessionStatus(
          `No Supabase session (smoke test continues locally): ${err instanceof Error ? err.message : String(err)}`,
        ),
    )
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const presenter = new Presenter(canvas)
    presenter.drawBlank()
    presenterRef.current = presenter

    const onResize = () => presenter.resize()
    window.addEventListener("resize", onResize)

    const onKeyDown = (e: KeyboardEvent) => {
      if (!runnerRef.current) return
      if (e.key === " ") e.preventDefault()
      if (e.repeat) return
      runnerRef.current.submitInput({ key: e.key, timestamp: performance.now() })
    }
    window.addEventListener("keydown", onKeyDown)

    return () => {
      window.removeEventListener("resize", onResize)
      window.removeEventListener("keydown", onKeyDown)
      presenterRef.current = null
    }
  }, [])

  async function handleContinue() {
    const presenter = presenterRef.current
    if (!presenter) return

    setStage("running")
    setError(null)
    try {
      const frameSource = new BrowserFrameSource()

      // Measure the real display refresh rate so phase frame counts match
      // the actual monitor rather than assuming 60Hz.
      const calibration = await runCalibration(frameSource, { sampleFrames: 30 })
      const refreshHz = Math.round(calibration.refreshHz)

      const runner = new TrialRunner(frameSource, refreshHz)
      runnerRef.current = runner

      const trialResult = await runner.runTrial(trialNode, (phaseIndex) => {
        drawPhase(presenter, trialNode.phases[phaseIndex])
      })

      runnerRef.current = null
      presenter.drawBlank()
      setResult(trialResult)
      setStage("done")
    } catch (err) {
      runnerRef.current = null
      setError(err instanceof Error ? err.message : String(err))
      setStage("consent")
    }
  }

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 p-6">
      <p className="text-xs text-muted-foreground">{sessionStatus}</p>

      {stage === "consent" && (
        <section className="flex flex-col gap-3">
          <p className="whitespace-pre-wrap">{consentNode.markdown}</p>
          <button
            type="button"
            className="self-start rounded-md bg-primary px-4 py-2 text-primary-foreground"
            onClick={() => void handleContinue()}
          >
            Continue
          </button>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </section>
      )}

      {stage === "done" && result && (
        <section className="flex flex-col gap-3">
          <p className="text-lg font-medium">{endNode.message}</p>
          <pre className="overflow-auto rounded-md border p-3 text-xs">
            {JSON.stringify(result, null, 2)}
          </pre>
        </section>
      )}

      <canvas
        ref={canvasRef}
        className="w-full rounded-md border"
        style={{ height: "60vh", display: stage === "done" ? "none" : "block" }}
      />
    </main>
  )
}

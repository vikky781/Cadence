import type { Session } from "@supabase/supabase-js"
import { useEffect, useMemo, useState } from "react"

import { ExperimentSchema, lintExperiment, type Experiment, type LintResult } from "../dsl"
import { AuthGate } from "../lib/AuthGate"
import { getSupabaseClient } from "../runtime/session"

type NodeType = "consent" | "instructions" | "trial" | "end"

interface NodeForm {
  uid: string
  id: string
  type: NodeType
  markdown: string
  declineNodeId: string
  next: string
  advanceBy: "key" | "button"
  phasesJson: string
  responseJson: string
  message: string
  redirect: string
}

function blankNode(type: NodeType, id: string): NodeForm {
  return {
    uid: crypto.randomUUID(),
    id,
    type,
    markdown: "",
    declineNodeId: "",
    next: "",
    advanceBy: "button",
    phasesJson: "[]",
    responseJson: "",
    message: "",
    redirect: "",
  }
}

const STARTER_NODES: NodeForm[] = [
  {
    ...blankNode("consent", "consent-1"),
    markdown: "Do you consent to take part in this study?",
    declineNodeId: "end-1",
    next: "trial-1",
  },
  {
    ...blankNode("trial", "trial-1"),
    phasesJson: JSON.stringify(
      [
        { type: "fixation", duration: 500 },
        {
          type: "stimulus",
          duration: "untilResponse",
          content: { kind: "text", value: "Press SPACE" },
        },
      ],
      null,
      2,
    ),
    responseJson: JSON.stringify(
      { allowedKeys: [" "], timeoutMs: 5000, acceptInPhases: [1] },
      null,
      2,
    ),
    next: "end-1",
  },
  { ...blankNode("end", "end-1"), message: "Thanks for participating!" },
]

interface FormState {
  title: string
  description: string
  estimatedMinutes: string
  nodes: NodeForm[]
  entry: string
}

function parseJsonField(label: string, text: string, errors: string[]): unknown {
  try {
    return JSON.parse(text)
  } catch (err) {
    errors.push(`${label}: invalid JSON (${err instanceof Error ? err.message : String(err)})`)
    return undefined
  }
}

function buildDsl(
  form: FormState,
  experimentId: string,
  version: number,
  authorEmail: string,
): { dsl: unknown; errors: string[] } {
  const errors: string[] = []
  const nodes: Record<string, unknown> = {}

  const seenIds = new Set<string>()
  for (const n of form.nodes) {
    // Nodes are keyed by id, so a duplicate would silently overwrite another
    // node and hide it from the schema check and the linter.
    if (!n.id.trim()) errors.push("A node has an empty id.")
    if (seenIds.has(n.id)) errors.push(`Duplicate node id "${n.id}": node ids must be unique.`)
    seenIds.add(n.id)

    switch (n.type) {
      case "consent":
        nodes[n.id] = {
          type: "consent",
          id: n.id,
          markdown: n.markdown,
          declineNodeId: n.declineNodeId,
          next: n.next,
        }
        break
      case "instructions":
        nodes[n.id] = {
          type: "instructions",
          id: n.id,
          markdown: n.markdown,
          advanceBy: n.advanceBy,
          next: n.next,
        }
        break
      case "trial": {
        const phases = parseJsonField(`Node "${n.id}" phases`, n.phasesJson, errors)
        const response = n.responseJson.trim()
          ? parseJsonField(`Node "${n.id}" response`, n.responseJson, errors)
          : undefined
        nodes[n.id] = { type: "trial", id: n.id, phases, response, next: n.next }
        break
      }
      case "end":
        nodes[n.id] = {
          type: "end",
          id: n.id,
          message: n.message,
          ...(n.redirect.trim() ? { redirect: n.redirect.trim() } : {}),
        }
        break
    }
  }

  const dsl = {
    schemaVersion: 1,
    experimentId,
    version,
    meta: {
      title: form.title,
      description: form.description,
      authors: [authorEmail],
      estimatedMinutes: Number(form.estimatedMinutes),
    },
    assets: [],
    variables: [],
    entry: form.entry,
    nodes,
  }
  return { dsl, errors }
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

interface LintRun {
  signature: string
  dsl: Experiment
  result: LintResult
}

const STARTER_FORM: FormState = {
  title: "Reaction time study",
  description: "Press SPACE when the stimulus appears.",
  estimatedMinutes: "2",
  nodes: STARTER_NODES,
  entry: "consent-1",
}

// The draft is kept in this browser's localStorage so a reload doesn't lose
// work. It also remembers which study it belongs to and how many versions
// were published, so the next publish becomes version N+1 of the same study.
interface Draft {
  form: FormState
  experimentId: string
  experimentRowExists: boolean
  publishedCount: number
  publishedVersionId: string | null
}

function draftKey(userId: string): string {
  return `cadence:editor-draft:${userId}`
}

function loadDraft(userId: string): Draft | null {
  try {
    const raw = window.localStorage.getItem(draftKey(userId))
    if (!raw) return null
    const draft = JSON.parse(raw) as Draft
    if (!draft?.form || !Array.isArray(draft.form.nodes) || typeof draft.experimentId !== "string") {
      return null
    }
    return draft
  } catch {
    return null
  }
}

function saveDraft(userId: string, draft: Draft): void {
  try {
    window.localStorage.setItem(draftKey(userId), JSON.stringify(draft))
  } catch {
    // Storage can be unavailable (private mode, quota); the editor still works.
  }
}

function clearDraft(userId: string): void {
  try {
    window.localStorage.removeItem(draftKey(userId))
  } catch {
    // Ignore: nothing to clear if storage is unavailable.
  }
}

function Editor({ session }: { session: Session }) {
  const userId = session.user.id
  const [initialDraft] = useState(() => loadDraft(userId))
  const [form, setForm] = useState<FormState>(initialDraft?.form ?? STARTER_FORM)
  const [experimentId, setExperimentId] = useState(
    () => initialDraft?.experimentId ?? crypto.randomUUID(),
  )
  const [experimentRowExists, setExperimentRowExists] = useState(
    initialDraft?.experimentRowExists ?? false,
  )
  const [publishedCount, setPublishedCount] = useState(initialDraft?.publishedCount ?? 0)

  const [formErrors, setFormErrors] = useState<string[]>([])
  const [zodIssues, setZodIssues] = useState<string[]>([])
  const [lintRun, setLintRun] = useState<LintRun | null>(null)
  const [publishedVersionId, setPublishedVersionId] = useState<string | null>(
    initialDraft?.publishedVersionId ?? null,
  )
  const [publishError, setPublishError] = useState<string | null>(null)
  const [publishing, setPublishing] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    saveDraft(userId, { form, experimentId, experimentRowExists, publishedCount, publishedVersionId })
  }, [userId, form, experimentId, experimentRowExists, publishedCount, publishedVersionId])

  function startNewStudy() {
    if (!window.confirm("Start a new study? This clears the current draft from this browser. Published studies are not affected.")) {
      return
    }
    clearDraft(userId)
    setForm(STARTER_FORM)
    setExperimentId(crypto.randomUUID())
    setExperimentRowExists(false)
    setPublishedCount(0)
    setPublishedVersionId(null)
    setLintRun(null)
    setFormErrors([])
    setZodIssues([])
    setPublishError(null)
    setCopied(false)
  }

  const signature = useMemo(() => JSON.stringify(form), [form])
  const nodeIds = form.nodes.map((n) => n.id)
  const authorEmail = session.user.email ?? "unknown"
  const canPublish =
    lintRun !== null && lintRun.signature === signature && lintRun.result.errors.length === 0

  function updateForm(patch: Partial<FormState>) {
    setForm((prev) => ({ ...prev, ...patch }))
  }

  function updateNode(uid: string, patch: Partial<NodeForm>) {
    setForm((prev) => ({
      ...prev,
      nodes: prev.nodes.map((n) => (n.uid === uid ? { ...n, ...patch } : n)),
    }))
  }

  function runLinter() {
    setFormErrors([])
    setZodIssues([])
    setLintRun(null)

    const { dsl, errors } = buildDsl(form, experimentId, publishedCount + 1, authorEmail)
    if (errors.length > 0) {
      setFormErrors(errors)
      return
    }

    const parsed = ExperimentSchema.safeParse(dsl)
    if (!parsed.success) {
      setZodIssues(parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`))
      return
    }

    setLintRun({ signature, dsl: parsed.data, result: lintExperiment(parsed.data) })
  }

  async function publish() {
    if (!lintRun || !canPublish || publishing) return
    setPublishing(true)
    setPublishError(null)
    try {
      const supabase = getSupabaseClient()
      const dsl = lintRun.dsl
      const dslSha256 = await sha256Hex(JSON.stringify(dsl))

      if (!experimentRowExists) {
        const { error } = await supabase.from("experiments").insert({
          id: experimentId,
          owner_id: session.user.id,
          title: form.title,
          draft_dsl: dsl,
        })
        if (error) throw new Error(`Failed to create experiment: ${error.message}`)
        setExperimentRowExists(true)
      } else {
        const { error } = await supabase
          .from("experiments")
          .update({ title: form.title, draft_dsl: dsl, updated_at: new Date().toISOString() })
          .eq("id", experimentId)
        if (error) throw new Error(`Failed to update experiment: ${error.message}`)
      }

      const { data, error } = await supabase
        .from("experiment_versions")
        .insert({
          experiment_id: experimentId,
          version_number: dsl.version,
          dsl,
          dsl_sha256: dslSha256,
        })
        .select("id")
        .single()
      if (error) throw new Error(`Failed to publish version: ${error.message}`)

      setPublishedVersionId(data.id as string)
      setPublishedCount(dsl.version)
      setLintRun(null)
      setCopied(false)
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : String(err))
    } finally {
      setPublishing(false)
    }
  }

  async function copyLink() {
    if (!publishedVersionId) return
    await navigator.clipboard.writeText(`${window.location.origin}/run?version=${publishedVersionId}`)
    setCopied(true)
  }

  const inputClass = "field"

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="flex min-w-0 flex-col gap-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Study editor</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">Build a study</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Define the screens participants move through, check the design, then publish a link.
          </p>
          <p className="mt-1 font-mono text-[11px] text-muted-foreground">
            Draft saved in this browser{publishedCount > 0 ? ` · ${publishedCount} version${publishedCount === 1 ? "" : "s"} published` : ""}
          </p>
        </div>
        <button type="button" className="btn btn-sm" onClick={startNewStudy}>
          Start a new study
        </button>
      </div>

      <section className="card grid gap-4 sm:grid-cols-[1fr_1fr_140px]">
        <label className="lbl">
          Title
          <input
            className={inputClass}
            value={form.title}
            onChange={(e) => updateForm({ title: e.target.value })}
          />
        </label>
        <label className="lbl">
          Description
          <input
            className={inputClass}
            value={form.description}
            onChange={(e) => updateForm({ description: e.target.value })}
          />
        </label>
        <label className="lbl">
          Estimated minutes
          <input
            className={inputClass}
            value={form.estimatedMinutes}
            onChange={(e) => updateForm({ estimatedMinutes: e.target.value })}
          />
        </label>
      </section>

      <datalist id="node-ids">
        {nodeIds.map((id, i) => (
          <option key={`${id}-${i}`} value={id} />
        ))}
      </datalist>

      <section className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-base font-semibold">Screens</h2>
          <span className="eyebrow">{form.nodes.length} nodes</span>
        </div>
        {form.nodes.map((n) => (
          <div key={n.uid} className="card flex flex-col gap-3">
            <div className="flex gap-2">
              <label className="lbl flex-1">
                id
                <input
                  className={inputClass}
                  value={n.id}
                  onChange={(e) => updateNode(n.uid, { id: e.target.value })}
                />
              </label>
              <label className="lbl">
                type
                <select
                  className={inputClass}
                  value={n.type}
                  onChange={(e) => updateNode(n.uid, { type: e.target.value as NodeType })}
                >
                  <option value="consent">consent</option>
                  <option value="instructions">instructions</option>
                  <option value="trial">trial</option>
                  <option value="end">end</option>
                </select>
              </label>
            </div>

            {(n.type === "consent" || n.type === "instructions") && (
              <label className="lbl">
                markdown
                <textarea
                  className={inputClass}
                  rows={3}
                  value={n.markdown}
                  onChange={(e) => updateNode(n.uid, { markdown: e.target.value })}
                />
              </label>
            )}
            {n.type === "consent" && (
              <label className="lbl">
                declineNodeId
                <input
                  className={inputClass}
                  list="node-ids"
                  value={n.declineNodeId}
                  onChange={(e) => updateNode(n.uid, { declineNodeId: e.target.value })}
                />
              </label>
            )}
            {n.type === "instructions" && (
              <label className="lbl">
                advanceBy
                <select
                  className={inputClass}
                  value={n.advanceBy}
                  onChange={(e) =>
                    updateNode(n.uid, { advanceBy: e.target.value as "key" | "button" })
                  }
                >
                  <option value="button">button</option>
                  <option value="key">key</option>
                </select>
              </label>
            )}
            {n.type === "trial" && (
              <>
                <label className="lbl">
                  phases (JSON)
                  <textarea
                    className={`${inputClass}`}
                    rows={8}
                    value={n.phasesJson}
                    onChange={(e) => updateNode(n.uid, { phasesJson: e.target.value })}
                  />
                </label>
                <label className="lbl">
                  response (JSON, optional)
                  <textarea
                    className={`${inputClass}`}
                    rows={4}
                    value={n.responseJson}
                    onChange={(e) => updateNode(n.uid, { responseJson: e.target.value })}
                  />
                </label>
              </>
            )}
            {n.type !== "end" && (
              <label className="lbl">
                next
                <input
                  className={inputClass}
                  list="node-ids"
                  value={n.next}
                  onChange={(e) => updateNode(n.uid, { next: e.target.value })}
                />
              </label>
            )}
            {n.type === "end" && (
              <>
                <label className="lbl">
                  message
                  <input
                    className={inputClass}
                    value={n.message}
                    onChange={(e) => updateNode(n.uid, { message: e.target.value })}
                  />
                </label>
                <label className="lbl">
                  redirect (optional URL)
                  <input
                    className={inputClass}
                    value={n.redirect}
                    onChange={(e) => updateNode(n.uid, { redirect: e.target.value })}
                  />
                </label>
              </>
            )}

            <button
              type="button"
              className="btn btn-quiet self-start"
              onClick={() => updateForm({ nodes: form.nodes.filter((x) => x.uid !== n.uid) })}
            >
              Remove node
            </button>
          </div>
        ))}
        <button
          type="button"
          className="btn btn-sm self-start"
          onClick={() =>
            updateForm({ nodes: [...form.nodes, blankNode("instructions", `node-${form.nodes.length + 1}`)] })
          }
        >
          Add screen
        </button>
      </section>

      <label className="lbl card">
        First screen (entry)
        <select
          className={inputClass}
          value={form.entry}
          onChange={(e) => updateForm({ entry: e.target.value })}
        >
          {nodeIds.map((id, i) => (
            <option key={`${id}-${i}`} value={id}>
              {id}
            </option>
          ))}
        </select>
      </label>

      </div>

      <aside className="flex flex-col gap-4 lg:sticky lg:top-24 lg:self-start">
      <div className="card flex flex-col gap-3">
        <p className="eyebrow">Check & publish</p>
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          className="btn"
          onClick={runLinter}
        >
          Run Linter
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!canPublish || publishing}
          onClick={() => void publish()}
        >
          {publishing ? "Publishing…" : "Publish"}
        </button>
      </div>
      {!canPublish && (
        <p className="text-xs text-muted-foreground">
          {lintRun && lintRun.signature === signature
            ? "Fix the errors below to publish."
            : "Run the checks on the current version to enable publishing."}
        </p>
      )}
      </div>

      {(formErrors.length > 0 || zodIssues.length > 0) && (
        <div role="alert" className="card flex flex-col gap-2 border-destructive/40">
          <p className="eyebrow text-destructive">Fix before checking</p>
          <ul className="flex flex-col gap-1.5 text-sm text-destructive">
            {[...formErrors, ...zodIssues].map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      {lintRun && lintRun.signature === signature && (
        <div className="card flex flex-col gap-4">
          <p className={lintRun.result.valid ? "text-sm font-medium text-signal" : "text-sm font-medium text-destructive"}>
            {lintRun.result.valid
              ? "No errors: ready to publish."
              : `${lintRun.result.errors.length} error${lintRun.result.errors.length === 1 ? "" : "s"} blocking publish.`}
          </p>
          {(
            [
              ["Errors", lintRun.result.errors, "text-destructive"],
              ["Warnings", lintRun.result.warnings, "text-[#8A5A00]"],
              ["Info", lintRun.result.infos, "text-graphite"],
            ] as const
          ).map(([label, issues, tone]) => (
            <div key={label} className="flex flex-col gap-2">
              <p className="eyebrow flex justify-between">
                <span>{label}</span>
                <span className={issues.length > 0 ? tone : ""}>{issues.length}</span>
              </p>
              {issues.length > 0 && (
                <ul className="flex flex-col gap-2">
                  {issues.map((issue, i) => (
                    <li key={i} className="flex flex-col gap-1 border-l-2 border-current pl-3 text-sm">
                      <span className={`font-mono text-[11px] ${tone}`}>
                        {issue.rule}
                        {issue.nodeId ? ` · ${issue.nodeId}` : ""}
                      </span>
                      <span className="text-foreground">{issue.message}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}

      {publishError && (
        <p role="alert" className="card border-destructive/40 text-sm text-destructive">
          {publishError}
        </p>
      )}
      {publishedVersionId && (
        <div className="card flex flex-col gap-3 border-signal/50">
          <p className="eyebrow text-signal">Published · version {publishedCount}</p>
          <code data-testid="version-id" className="break-all font-mono text-xs text-muted-foreground">
            {publishedVersionId}
          </code>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" className="btn btn-signal btn-sm" onClick={() => void copyLink()}>
              {copied ? "Copied" : "Copy participant link"}
            </button>
            <a className="btn btn-sm" href={`/results?version=${publishedVersionId}`}>
              View results
            </a>
          </div>
        </div>
      )}
      </aside>
    </div>
  )
}

export default function ExperimentEditor() {
  return <AuthGate>{(session) => <Editor session={session} />}</AuthGate>
}

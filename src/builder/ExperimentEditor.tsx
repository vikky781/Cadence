import type { Session } from "@supabase/supabase-js"
import { useMemo, useState } from "react"

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

  for (const n of form.nodes) {
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

function Editor({ session }: { session: Session }) {
  const [form, setForm] = useState<FormState>({
    title: "Reaction time study",
    description: "Press SPACE when the stimulus appears.",
    estimatedMinutes: "2",
    nodes: STARTER_NODES,
    entry: "consent-1",
  })
  const [experimentId] = useState(() => crypto.randomUUID())
  const [experimentRowExists, setExperimentRowExists] = useState(false)
  const [publishedCount, setPublishedCount] = useState(0)

  const [formErrors, setFormErrors] = useState<string[]>([])
  const [zodIssues, setZodIssues] = useState<string[]>([])
  const [lintRun, setLintRun] = useState<LintRun | null>(null)
  const [publishedVersionId, setPublishedVersionId] = useState<string | null>(null)
  const [publishError, setPublishError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

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
    if (!lintRun || !canPublish) return
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
    }
  }

  async function copyLink() {
    if (!publishedVersionId) return
    await navigator.clipboard.writeText(`${window.location.origin}/run?version=${publishedVersionId}`)
    setCopied(true)
  }

  const inputClass = "w-full rounded-md border px-2 py-1"

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-5 p-6">
      <h1 className="text-xl font-medium">Experiment editor</h1>
      <p className="text-xs text-muted-foreground">Signed in as {authorEmail}</p>

      <section className="flex flex-col gap-2">
        <label className="text-sm">
          Title
          <input
            className={inputClass}
            value={form.title}
            onChange={(e) => updateForm({ title: e.target.value })}
          />
        </label>
        <label className="text-sm">
          Description
          <input
            className={inputClass}
            value={form.description}
            onChange={(e) => updateForm({ description: e.target.value })}
          />
        </label>
        <label className="text-sm">
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
        <h2 className="font-medium">Nodes</h2>
        {form.nodes.map((n) => (
          <div key={n.uid} className="flex flex-col gap-2 rounded-md border p-3">
            <div className="flex gap-2">
              <label className="flex-1 text-sm">
                id
                <input
                  className={inputClass}
                  value={n.id}
                  onChange={(e) => updateNode(n.uid, { id: e.target.value })}
                />
              </label>
              <label className="text-sm">
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
              <label className="text-sm">
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
              <label className="text-sm">
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
              <label className="text-sm">
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
                <label className="text-sm">
                  phases (JSON)
                  <textarea
                    className={`${inputClass} font-mono text-xs`}
                    rows={8}
                    value={n.phasesJson}
                    onChange={(e) => updateNode(n.uid, { phasesJson: e.target.value })}
                  />
                </label>
                <label className="text-sm">
                  response (JSON, optional)
                  <textarea
                    className={`${inputClass} font-mono text-xs`}
                    rows={4}
                    value={n.responseJson}
                    onChange={(e) => updateNode(n.uid, { responseJson: e.target.value })}
                  />
                </label>
              </>
            )}
            {n.type !== "end" && (
              <label className="text-sm">
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
                <label className="text-sm">
                  message
                  <input
                    className={inputClass}
                    value={n.message}
                    onChange={(e) => updateNode(n.uid, { message: e.target.value })}
                  />
                </label>
                <label className="text-sm">
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
              className="self-start text-sm text-destructive"
              onClick={() => updateForm({ nodes: form.nodes.filter((x) => x.uid !== n.uid) })}
            >
              Remove node
            </button>
          </div>
        ))}
        <button
          type="button"
          className="self-start rounded-md border px-3 py-1 text-sm"
          onClick={() =>
            updateForm({ nodes: [...form.nodes, blankNode("instructions", `node-${form.nodes.length + 1}`)] })
          }
        >
          Add node
        </button>
      </section>

      <label className="text-sm">
        Entry node
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

      <div className="flex gap-2">
        <button
          type="button"
          className="rounded-md border px-4 py-2"
          onClick={runLinter}
        >
          Run Linter
        </button>
        <button
          type="button"
          className="rounded-md bg-primary px-4 py-2 text-primary-foreground disabled:opacity-40"
          disabled={!canPublish}
          onClick={() => void publish()}
        >
          Publish
        </button>
      </div>

      {formErrors.length > 0 && (
        <ul className="list-disc pl-5 text-sm text-destructive">
          {formErrors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
      {zodIssues.length > 0 && (
        <div>
          <p className="text-sm font-medium text-destructive">Schema errors</p>
          <ul className="list-disc pl-5 text-sm text-destructive">
            {zodIssues.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}
      {lintRun && lintRun.signature === signature && (
        <div className="flex flex-col gap-2 text-sm">
          {(
            [
              ["Errors", lintRun.result.errors],
              ["Warnings", lintRun.result.warnings],
              ["Info", lintRun.result.infos],
            ] as const
          ).map(([label, issues]) => (
            <div key={label}>
              <p className="font-medium">
                {label} ({issues.length})
              </p>
              <ul className="list-disc pl-5">
                {issues.map((issue, i) => (
                  <li key={i}>
                    [{issue.rule}] {issue.nodeId ? `${issue.nodeId}: ` : ""}
                    {issue.message}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {lintRun.result.valid && <p className="text-green-700">No errors: ready to publish.</p>}
        </div>
      )}

      {publishError && <p className="text-sm text-destructive">{publishError}</p>}
      {publishedVersionId && (
        <div className="flex flex-col gap-2 rounded-md border p-3 text-sm">
          <p>
            Published version id: <code data-testid="version-id">{publishedVersionId}</code>
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded-md border px-3 py-1"
              onClick={() => void copyLink()}
            >
              {copied ? "Copied" : "Copy participant link"}
            </button>
            <a className="underline" href={`/results?version=${publishedVersionId}`}>
              View results
            </a>
          </div>
        </div>
      )}
    </main>
  )
}

export default function ExperimentEditor() {
  return <AuthGate>{(session) => <Editor session={session} />}</AuthGate>
}

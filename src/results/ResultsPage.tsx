import Papa from "papaparse"
import { useEffect, useState } from "react"

import { AuthGate } from "../lib/AuthGate"
import { getSupabaseClient } from "../runtime/session"

interface TrialRow {
  session_id: string
  sequence_number: number
  node_id: string
  response: string | null
  reaction_time_ms: number | null
  correct: boolean | null
  quality_flag: string
}

function Results({ versionId }: { versionId: string }) {
  const [rows, setRows] = useState<TrialRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const supabase = getSupabaseClient()

        // RLS hides other researchers' sessions/trials by returning empty
        // results, not an error, so check ownership explicitly first rather
        // than showing a misleading "no trials yet".
        const { data: version, error: versionError } = await supabase
          .from("experiment_versions")
          .select("experiment_id")
          .eq("id", versionId)
          .maybeSingle()
        if (versionError) throw new Error(`Failed to load version: ${versionError.message}`)
        if (!version) throw new Error(`No experiment version with id ${versionId}.`)

        const { data: experiment, error: experimentError } = await supabase
          .from("experiments")
          .select("id")
          .eq("id", version.experiment_id as string)
          .maybeSingle()
        if (experimentError) throw new Error(`Failed to load experiment: ${experimentError.message}`)
        if (!experiment) {
          throw new Error(
            "This experiment belongs to another researcher account, so its results are not visible to you.",
          )
        }

        const { data: sessions, error: sessionsError } = await supabase
          .from("sessions")
          .select("id")
          .eq("version_id", versionId)
        if (sessionsError) throw new Error(`Failed to load sessions: ${sessionsError.message}`)

        const sessionIds = (sessions ?? []).map((s) => s.id as string)
        if (sessionIds.length === 0) {
          if (!cancelled) setRows([])
          return
        }

        const { data: trials, error: trialsError } = await supabase
          .from("trials")
          .select("session_id, sequence_number, node_id, response, reaction_time_ms, correct, quality_flag")
          .in("session_id", sessionIds)
          .order("session_id")
          .order("sequence_number")
        if (trialsError) throw new Error(`Failed to load trials: ${trialsError.message}`)

        if (!cancelled) setRows((trials ?? []) as TrialRow[])
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [versionId])

  function downloadCsv() {
    if (!rows) return
    const csv = Papa.unparse(rows)
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = `results-${versionId}.csv`
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    // Revoking synchronously can cancel the download: the browser fetches the
    // blob URL asynchronously after click(), so release it a moment later.
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const sessionCount = rows ? new Set(rows.map((r) => r.session_id)).size : 0
  const rts = rows?.map((r) => r.reaction_time_ms).filter((v): v is number => v !== null) ?? []
  const medianRt = rts.length
    ? [...rts].sort((x, y) => x - y)[Math.floor((rts.length - 1) / 2)]
    : null

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Results</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">Trial data</h1>
          <p className="mt-1 break-all font-mono text-xs text-muted-foreground">version {versionId}</p>
        </div>
        {rows && (
          <button type="button" className="btn btn-primary" disabled={rows.length === 0} onClick={downloadCsv}>
            Download CSV
          </button>
        )}
      </div>

      {error && (
        <p role="alert" className="card border-destructive/40 text-sm text-destructive">
          {error}
        </p>
      )}
      {!error && rows === null && <p className="eyebrow">Loading trials…</p>}

      {rows && (
        <>
          <dl className="grid grid-cols-3 gap-px overflow-hidden rounded-lg border bg-border">
            {(
              [
                ["Sessions", String(sessionCount)],
                ["Trials", String(rows.length)],
                ["Median RT", medianRt === null ? "—" : `${medianRt.toFixed(0)} ms`],
              ] as const
            ).map(([k, v]) => (
              <div key={k} className="bg-card px-4 py-3">
                <dt className="eyebrow">{k}</dt>
                <dd className="mt-1 font-mono text-xl tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>

          {rows.length === 0 ? (
            <div className="card text-sm text-muted-foreground">
              No trials yet. Share the participant link from the editor; completed trials appear here.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border bg-card">
              <table className="w-full border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b bg-muted/60">
                    {["Session", "Seq", "Node", "Response", "RT (ms)", "Correct", "Quality"].map((h) => (
                      <th key={h} scope="col" className="eyebrow px-4 py-2.5 font-medium whitespace-nowrap">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="font-mono text-[13px] tabular-nums">
                  {rows.map((r) => (
                    <tr key={`${r.session_id}-${r.sequence_number}`} className="border-b last:border-0 hover:bg-muted/40">
                      <td className="px-4 py-2.5 text-muted-foreground">{r.session_id.slice(0, 8)}</td>
                      <td className="px-4 py-2.5">{r.sequence_number}</td>
                      <td className="px-4 py-2.5">{r.node_id}</td>
                      <td className="px-4 py-2.5">{r.response === " " ? "Space" : (r.response ?? "—")}</td>
                      <td className="px-4 py-2.5 text-right">{r.reaction_time_ms === null ? "—" : r.reaction_time_ms.toFixed(1)}</td>
                      <td className="px-4 py-2.5">{r.correct === null ? "—" : String(r.correct)}</td>
                      <td className="px-4 py-2.5">
                        <span className={r.quality_flag === "good" ? "tag border-signal/40 text-signal" : "tag border-destructive/40 text-destructive"}>
                          {r.quality_flag}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}

export default function ResultsPage() {
  const versionId = new URLSearchParams(window.location.search).get("version")

  return (
    <AuthGate>
      {() =>
        versionId ? (
          <Results versionId={versionId} />
        ) : (
          <p role="alert" className="card text-sm text-destructive">
            This link is missing a study version. Open results from the editor after publishing.
          </p>
        )
      }
    </AuthGate>
  )
}

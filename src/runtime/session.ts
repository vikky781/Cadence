import { createClient, type SupabaseClient } from "@supabase/supabase-js"

import type { BufferedTrial } from "../engine/localBuffer"

let client: SupabaseClient | null = null

export function getSupabaseClient(): SupabaseClient {
  if (client) return client

  const url = import.meta.env.VITE_SUPABASE_URL
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
  if (!url || !anonKey) {
    throw new Error(
      "Missing Supabase configuration: VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must both be set (see .env.example).",
    )
  }

  client = createClient(url, anonKey)
  return client
}

export async function ensureAnonymousSession(): Promise<string> {
  const supabase = getSupabaseClient()

  const { data: sessionData, error: sessionError } = await supabase.auth.getSession()
  if (sessionError) {
    throw new Error(`Failed to read auth session: ${sessionError.message}`)
  }
  if (sessionData.session) {
    if (!sessionData.session.user.is_anonymous) {
      throw new Error(
        "This browser is signed in as a researcher account, which cannot start participant sessions. Open the participant link in a private window or another browser.",
      )
    }
    return sessionData.session.user.id
  }

  const { data, error } = await supabase.auth.signInAnonymously()
  if (error) {
    throw new Error(`Anonymous sign-in failed: ${error.message}`)
  }
  if (!data.user) {
    throw new Error("Anonymous sign-in returned no user.")
  }
  return data.user.id
}

export async function createSession(versionId: string, seed: string): Promise<string> {
  const supabase = getSupabaseClient()

  // participant_uid defaults to auth.uid() in the database, and
  // assigned_arm / device_info / calibration are left null for now.
  const { data, error } = await supabase
    .from("sessions")
    .insert({ version_id: versionId, seed })
    .select("id")
    .single()

  if (error) {
    throw new Error(`Failed to create session: ${error.message}`)
  }
  return data.id as string
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

export async function uploadTrial(
  sessionId: string,
  sequenceNumber: number,
  trial: Omit<BufferedTrial, "uploaded">,
): Promise<void> {
  const supabase = getSupabaseClient()

  // This is a per-trial content hash only. It is NOT yet a hash chain
  // linking to the previous trial's hash -- chaining is a deliberate scope
  // cut for now (post-hackathon anchoring work).
  const recordHash = await sha256Hex(
    JSON.stringify({
      sequenceNumber,
      nodeId: trial.nodeId,
      response: trial.response,
      reactionTimeMs: trial.reactionTimeMs,
    }),
  )

  // No .select() here: participants have INSERT but no SELECT policy on
  // trials, so returning the inserted row would fail under RLS.
  const { error } = await supabase.from("trials").insert({
    session_id: sessionId,
    sequence_number: sequenceNumber,
    node_id: trial.nodeId,
    stimulus_row: trial.stimulusRow,
    response: trial.response,
    reaction_time_ms: trial.reactionTimeMs,
    correct: trial.correct,
    timing_evidence: trial.timingEvidence,
    quality_flag: trial.qualityFlag,
    record_hash: recordHash,
  })

  if (error) {
    // 23505 = unique_violation on (session_id, sequence_number): this trial
    // was already uploaded, so a retry is a successful no-op.
    if (error.code === "23505") return
    throw new Error(`Failed to upload trial ${sequenceNumber}: ${error.message}`)
  }
}

export async function markSessionComplete(sessionId: string): Promise<void> {
  const supabase = getSupabaseClient()

  // .select("id") so that an update filtered out by RLS (which returns no
  // error, just zero rows) is detected instead of failing silently.
  const { data, error } = await supabase
    .from("sessions")
    .update({ status: "completed" })
    .eq("id", sessionId)
    .select("id")

  if (error) {
    throw new Error(`Failed to mark session complete: ${error.message}`)
  }
  if (!data || data.length === 0) {
    throw new Error(
      `Failed to mark session ${sessionId} complete: no row was updated (wrong id, or not permitted by RLS).`,
    )
  }
}

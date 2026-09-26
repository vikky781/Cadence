import type { ReactNode } from "react"

import { getSupabaseClient } from "../runtime/session"

export function AppShell({
  email,
  children,
}: {
  email?: string
  children: ReactNode
}) {
  return (
    <div className="min-h-dvh bg-background font-sans text-foreground">
      <header className="shell-header">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <a href="/" className="flex items-baseline gap-2 focus-visible:outline-none">
            <span className="text-[15px] font-semibold tracking-tight">Cadence</span>
            <span className="eyebrow hidden sm:inline">frame-locked experiments</span>
          </a>
          {email && (
            <div className="flex items-center gap-3">
              <span className="hidden font-mono text-xs text-muted-foreground sm:inline">{email}</span>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void getSupabaseClient().auth.signOut()}
              >
                Sign out
              </button>
            </div>
          )}
        </div>
        <div className="frame-ruler mx-auto max-w-6xl" aria-hidden="true" />
      </header>
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">{children}</div>
    </div>
  )
}

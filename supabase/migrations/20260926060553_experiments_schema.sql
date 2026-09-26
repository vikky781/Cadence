-- ============================================================================
-- Cadence experiment platform: core schema and Row Level Security policies
-- ============================================================================
--
-- Data sensitivity model, in plain English:
--
-- Participants take part in experiments PSEUDONYMOUSLY. When someone starts a
-- session, Supabase signs them in as an anonymous auth user; their JWT carries
-- an `is_anonymous: true` claim. That anonymous `auth.uid()` is the only
-- "identity" ever attached to their data here -- a random, unguessable UUID
-- with no email, name, or other real-world identifier behind it.
-- `sessions.participant_uid`, and everything joined off of it (`trials`,
-- `participant_links`), is therefore pseudonymous: rows can be tied back to
-- "the same anonymous participant" but not to a real person, unless an
-- external recruiting platform (e.g. Prolific) is later able to match
-- `participant_links.recruiter_pid` against its own separately-held records.
-- That external correlation happens outside this database; inside it,
-- `recruiter_pid` / `recruiter_study_id` are only ever written by the
-- participant's own session and only ever read by the researcher who owns
-- the experiment.
--
-- Researcher accounts ARE identifiable: `experiments.owner_id` is a normal,
-- non-anonymous authenticated Supabase user tied to a real login (email,
-- OAuth identity, etc.).
--
-- Summary:
--   - identifiable:  experiments.owner_id (and anything scoped to an owner)
--   - pseudonymous:  sessions.participant_uid, trials, participant_links
--   - the `is_anonymous` JWT claim is exactly what the RLS policies below use
--     to tell a genuine participant session apart from a researcher session.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Tables
-- ----------------------------------------------------------------------------

create table experiments (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id),
  title text not null,
  draft_dsl jsonb not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table experiment_versions (
  id uuid primary key default gen_random_uuid(),
  experiment_id uuid not null references experiments(id),
  version_number integer not null,
  dsl jsonb not null,
  dsl_sha256 text not null,
  published_at timestamptz default now(),
  unique (experiment_id, version_number)
);

create table sessions (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references experiment_versions(id),
  participant_uid uuid not null default auth.uid(),
  seed text not null,
  assigned_arm text,
  device_info jsonb,
  calibration jsonb,
  status text not null default 'running' check (status in ('running', 'completed', 'abandoned')),
  chain_head text,
  created_at timestamptz default now()
);

create table trials (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id),
  sequence_number integer not null,
  node_id text not null,
  stimulus_row jsonb,
  response text,
  reaction_time_ms numeric,
  correct boolean,
  timing_evidence jsonb not null,
  quality_flag text not null check (quality_flag in ('good', 'degraded', 'invalid')),
  record_hash text not null,
  created_at timestamptz default now(),
  unique (session_id, sequence_number)
);

create table participant_links (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id),
  recruiter_pid text,
  recruiter_study_id text,
  created_at timestamptz default now()
);

-- ----------------------------------------------------------------------------
-- Row Level Security
-- ----------------------------------------------------------------------------

alter table experiments enable row level security;
alter table experiment_versions enable row level security;
alter table sessions enable row level security;
alter table trials enable row level security;
alter table participant_links enable row level security;

-- ----------------------------------------------------------------------------
-- experiments: owner has full CRUD on their own rows.
-- ----------------------------------------------------------------------------

create policy "experiments: owner can select"
  on experiments for select
  to authenticated
  using (owner_id = auth.uid());

create policy "experiments: owner can insert"
  on experiments for insert
  to authenticated
  with check (owner_id = auth.uid());

create policy "experiments: owner can update"
  on experiments for update
  to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create policy "experiments: owner can delete"
  on experiments for delete
  to authenticated
  using (owner_id = auth.uid());

-- ----------------------------------------------------------------------------
-- experiment_versions: owner can select/insert via the parent experiment.
-- Intentionally NO update or delete policy for any role -- published versions
-- are immutable by omission; once written, a version can never be changed or
-- removed through the API.
-- ----------------------------------------------------------------------------

create policy "experiment_versions: owner can select"
  on experiment_versions for select
  to authenticated
  using (
    exists (
      select 1
      from experiments
      where experiments.id = experiment_versions.experiment_id
        and experiments.owner_id = auth.uid()
    )
  );

create policy "experiment_versions: owner can insert"
  on experiment_versions for insert
  to authenticated
  with check (
    exists (
      select 1
      from experiments
      where experiments.id = experiment_versions.experiment_id
        and experiments.owner_id = auth.uid()
    )
  );

-- ----------------------------------------------------------------------------
-- sessions:
--   - a session may only ever be created by an anonymous participant
--     (RESTRICTIVE: requires the `is_anonymous` JWT claim), inserting a row
--     that names themselves as the participant.
--   - a participant can select/update their own session.
--   - the owning researcher can select sessions belonging to their
--     experiments (via version -> experiment).
-- ----------------------------------------------------------------------------

create policy "sessions: participant can insert own row"
  on sessions for insert
  to authenticated
  with check (participant_uid = auth.uid());

create policy "sessions: only anonymous participants can insert"
  on sessions as restrictive
  for insert
  to authenticated
  with check ((auth.jwt() ->> 'is_anonymous')::boolean is true);

create policy "sessions: participant can select own row"
  on sessions for select
  to authenticated
  using (participant_uid = auth.uid());

create policy "sessions: participant can update own row"
  on sessions for update
  to authenticated
  using (participant_uid = auth.uid())
  with check (participant_uid = auth.uid());

create policy "sessions: owner can select sessions for their experiments"
  on sessions for select
  to authenticated
  using (
    exists (
      select 1
      from experiment_versions
      join experiments on experiments.id = experiment_versions.experiment_id
      where experiment_versions.id = sessions.version_id
        and experiments.owner_id = auth.uid()
    )
  );

-- ----------------------------------------------------------------------------
-- trials: INSERT only for the participant who owns the session -- no update
-- or delete policy for any role, so a submitted trial record can never be
-- altered after the fact. The owning researcher can select trials for their
-- experiments via the session -> version -> experiment chain.
-- ----------------------------------------------------------------------------

create policy "trials: participant can insert for own session"
  on trials for insert
  to authenticated
  with check (
    exists (
      select 1
      from sessions
      where sessions.id = trials.session_id
        and sessions.participant_uid = auth.uid()
    )
  );

create policy "trials: owner can select trials for their experiments"
  on trials for select
  to authenticated
  using (
    exists (
      select 1
      from sessions
      join experiment_versions on experiment_versions.id = sessions.version_id
      join experiments on experiments.id = experiment_versions.experiment_id
      where sessions.id = trials.session_id
        and experiments.owner_id = auth.uid()
    )
  );

-- ----------------------------------------------------------------------------
-- participant_links: INSERT by the participant who owns the session; SELECT
-- restricted to the owning researcher only (the participant themselves
-- cannot read recruiter linkage back).
-- ----------------------------------------------------------------------------

create policy "participant_links: participant can insert for own session"
  on participant_links for insert
  to authenticated
  with check (
    exists (
      select 1
      from sessions
      where sessions.id = participant_links.session_id
        and sessions.participant_uid = auth.uid()
    )
  );

create policy "participant_links: owner can select for their experiments"
  on participant_links for select
  to authenticated
  using (
    exists (
      select 1
      from sessions
      join experiment_versions on experiment_versions.id = sessions.version_id
      join experiments on experiments.id = experiment_versions.experiment_id
      where sessions.id = participant_links.session_id
        and experiments.owner_id = auth.uid()
    )
  );

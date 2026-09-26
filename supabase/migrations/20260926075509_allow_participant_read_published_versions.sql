-- ============================================================================
-- Allow any authenticated user (including anonymous participants) to read
-- published experiment versions.
-- ============================================================================
--
-- The original schema only let an experiment's owner SELECT its versions, so
-- an anonymous participant opening a study link could not load the study's
-- DSL. Anyone holding the link (the version id, an unguessable uuid) should
-- be able to load a published study, so this adds a permissive SELECT policy
-- for the `authenticated` role, which anonymous users also carry.
--
-- experiment_versions remains immutable: there is still NO update or delete
-- policy, and insert is still limited to the owning researcher.
-- ============================================================================

create policy "experiment_versions: any authenticated user can select"
  on experiment_versions for select
  to authenticated
  using (true);

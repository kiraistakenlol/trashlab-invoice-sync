-- Sync service schema baseline.

CREATE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE invoicing_qbo_links (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type            text NOT NULL
                         CHECK (entity_type IN ('account', 'item', 'customer', 'invoice', 'payment')),
  invoicing_id           text,
  qbo_id                 text,
  -- Created before the counterpart is: reused on every retry of that create.
  create_idempotency_key uuid NOT NULL DEFAULT gen_random_uuid(),
  -- Neutral form of the synced fields at the last successful sync; null until then.
  snapshot               jsonb,
  invoicing_version      integer,
  qbo_sync_token         text,
  -- Bumped on every update; writers update only the version they read.
  version                integer NOT NULL DEFAULT 1,
  deleted_at             timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (invoicing_id IS NOT NULL OR qbo_id IS NOT NULL)
);
CREATE UNIQUE INDEX invoicing_qbo_links_invoicing_key ON invoicing_qbo_links (entity_type, invoicing_id);
CREATE UNIQUE INDEX invoicing_qbo_links_qbo_key ON invoicing_qbo_links (entity_type, qbo_id);
CREATE TRIGGER invoicing_qbo_links_updated_at BEFORE UPDATE ON invoicing_qbo_links
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Jobs, issues and audit entries name the record they are about (system, entity_type,
-- entity_id), plus its link once there is one.

CREATE TABLE sync_jobs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  system      text NOT NULL CHECK (system IN ('invoicing', 'qbo')),
  entity_type text NOT NULL,
  entity_id   text NOT NULL,
  status      text NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'running', 'done', 'failed')),
  attempts    integer NOT NULL DEFAULT 0,
  run_after   timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
-- Notifications for a record merge into its pending job; one job per record runs at a time.
CREATE UNIQUE INDEX sync_jobs_pending_key ON sync_jobs (system, entity_type, entity_id)
  WHERE status = 'pending';
CREATE UNIQUE INDEX sync_jobs_running_key ON sync_jobs (system, entity_type, entity_id)
  WHERE status = 'running';
CREATE INDEX sync_jobs_due_idx ON sync_jobs (run_after) WHERE status = 'pending';
CREATE TRIGGER sync_jobs_updated_at BEFORE UPDATE ON sync_jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- What the sync won't decide alone; an open issue parks its record and link.
CREATE TABLE sync_issues (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  system      text NOT NULL CHECK (system IN ('invoicing', 'qbo')),
  entity_type text NOT NULL,
  entity_id   text NOT NULL,
  link_id     uuid REFERENCES invoicing_qbo_links (id),
  kind        text NOT NULL CHECK (kind IN (
                'conflict', 'unsupported', 'revived_void', 'number_changed',
                'number_taken', 'ambiguous_match', 'taxed_lines_edited')),
  -- Fields in question and the versions involved (snapshot, invoicing, QBO).
  details     jsonb NOT NULL,
  resolved_at timestamptz,
  resolution  text CHECK (resolution IN ('invoicing', 'qbo', 'converged')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sync_issues_open_link_key ON sync_issues (link_id, kind)
  WHERE resolved_at IS NULL AND link_id IS NOT NULL;
CREATE UNIQUE INDEX sync_issues_open_entity_key ON sync_issues (system, entity_type, entity_id, kind)
  WHERE resolved_at IS NULL AND link_id IS NULL;
CREATE TRIGGER sync_issues_updated_at BEFORE UPDATE ON sync_issues
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Append-only: every notification received and every step the sync took.
CREATE TABLE audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  system      text NOT NULL CHECK (system IN ('invoicing', 'qbo')),
  entity_type text NOT NULL,
  entity_id   text NOT NULL,
  job_id      uuid REFERENCES sync_jobs (id),
  action      text NOT NULL CHECK (action IN (
                'notification_received', 'linked', 'created', 'updated', 'voided', 'deleted',
                'no_change', 'issue_opened', 'issue_resolved')),
  -- Per field: { from, to, source }.
  changes     jsonb,
  -- Null when the action succeeded.
  error       text,
  -- Notification payload, system response.
  details     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_entity_idx ON audit_log (system, entity_type, entity_id, id);

CREATE TABLE poll_cursors (
  system     text PRIMARY KEY CHECK (system IN ('invoicing', 'qbo')),
  cursor     text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER poll_cursors_updated_at BEFORE UPDATE ON poll_cursors
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

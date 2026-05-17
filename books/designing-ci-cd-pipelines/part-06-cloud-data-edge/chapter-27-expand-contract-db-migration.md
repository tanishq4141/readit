# Chapter 27: The Expand-and-Contract Database Migration Pattern
*Part VI: Cloud, Data & Edge Specialized Delivery*

> *"Rolling deploys and non-backward-compatible schema changes
> are incompatible. One of them will win.
> It's usually the schema change, and it wins by crashing your pods."*
> — database reliability engineer

---

## The War Story

The platform team at Meridian Health, a patient records SaaS, decides to rename a column. The `patient_records` table has a column called `dob` that should be `date_of_birth` — more readable, more explicit, aligns with their new API naming convention. The migration is straightforward:

```sql
ALTER TABLE patient_records RENAME COLUMN dob TO date_of_birth;
```

The migration runs in staging at 2 PM on a Tuesday. The tests pass — all of them use the Django ORM which was updated to use `date_of_birth` in the same PR. Looks clean.

At 3:47 PM, the migration runs in production as part of a rolling deployment. The deployment uses Kubernetes rolling updates: new pods start, old pods drain. The migration runs in the first new pod's init container before the pod starts serving traffic.

The migration completes in 4 seconds. The column is renamed. The new pod starts, reads `date_of_birth`, works fine.

The old pods — still running, still serving traffic during the rolling update — try to read `dob`. The column doesn't exist anymore.

```
django.db.utils.ProgrammingError: column "dob" does not exist
SELECT id, dob, first_name, last_name FROM patient_records WHERE ...
```

Four hundred patient record reads fail across the 90-second rolling update window. In a healthcare application. The on-call fires. The compliance team is notified. The incident takes 2 hours to resolve: the column must be renamed back (`date_of_birth` → `dob`), the new code must be rolled back, a postmortem must be written.

The root cause: a non-backward-compatible schema change applied during a rolling deployment. The two versions of the application — old pods reading `dob`, new pods reading `date_of_birth` — coexisted for 90 seconds and the database only had one version of the schema.

---

## What You'll Learn

- The Expand-and-Contract pattern: the four-phase approach to zero-downtime schema changes
- Implementation with Flyway and Liquibase: managing migrations as versioned, ordered artifacts
- gh-ost and pt-online-schema-change: online schema changes for large tables without locks
- The NOT NULL constraint trap: the specific migration sequence for adding required columns safely
- When to use managed migration services vs. application-controlled migrations
- The rollback problem: what's actually reversible and what isn't

---

## The Expand-and-Contract Pattern

Expand-and-Contract (also called Parallel Change) is a four-phase pattern for making schema changes that are safe across a rolling deployment window. The core principle: **at every point in time, the running application code must be compatible with the current database schema**.

```
Phase 1 — EXPAND:
  Add the new structure. Keep the old. Both exist simultaneously.
  Both old and new application code can run.

  Old code: reads/writes dob                    ✅ works (column exists)
  New code: reads date_of_birth, writes BOTH     ✅ works (both exist)

Phase 2 — MIGRATE:
  Backfill data from old structure to new.
  Application is still writing to both.
  No code change required for this phase.

Phase 3 — CONTRACT (first step):
  Update code to read ONLY from new structure.
  Still write to old structure for backward compatibility.
  Wait for all old code instances to drain.

  Old code: reads dob                            ✅ still works (column exists)
  New code: reads date_of_birth, writes BOTH     ✅ works

Phase 4 — CONTRACT (final step):
  Remove old structure.
  Only new code is running.

  New code: reads date_of_birth, writes only it  ✅ works
  Old code: would fail (dob gone)                ✅ not running anymore
```

Applied to the column rename:

```sql
-- Phase 1: EXPAND — add new column, keep old
-- Migration V1__add_date_of_birth.sql
ALTER TABLE patient_records ADD COLUMN date_of_birth DATE;

-- Application code at this point: writes to BOTH dob AND date_of_birth
-- UPDATE patient_records SET dob = $1, date_of_birth = $1 WHERE id = $2

-- Phase 2: MIGRATE — backfill existing rows
-- Migration V2__backfill_date_of_birth.sql
-- Run in batches to avoid locking the table
DO $$
DECLARE
  batch_size INT := 10000;
  offset_val INT := 0;
  rows_updated INT;
BEGIN
  LOOP
    UPDATE patient_records
    SET date_of_birth = dob
    WHERE id IN (
      SELECT id FROM patient_records
      WHERE date_of_birth IS NULL AND dob IS NOT NULL
      ORDER BY id
      LIMIT batch_size
    );

    GET DIAGNOSTICS rows_updated = ROW_COUNT;
    EXIT WHEN rows_updated = 0;
    offset_val := offset_val + batch_size;
    PERFORM pg_sleep(0.1); -- brief pause between batches to reduce I/O impact
  END LOOP;
END $$;

-- Phase 3: APPLICATION CHANGE — read from new column, write to both
-- (Code change deployed here, no migration yet)
-- SELECT date_of_birth FROM patient_records WHERE id = $1
-- UPDATE patient_records SET dob = $1, date_of_birth = $1 WHERE id = $2

-- Phase 4: CONTRACT — remove old column (deployed after all old code is gone)
-- Migration V3__drop_dob_column.sql
ALTER TABLE patient_records DROP COLUMN dob;
```

Each phase is a separate deployment. The total calendar time is longer than a single-migration approach, but zero downtime is maintained throughout.

---

## Implementation: Flyway Migration Sequencing

Flyway is the most widely used migration tool for Java/JVM applications. It applies versioned SQL migrations in order and tracks which have been applied in a `flyway_schema_history` table.

```
migrations/
├── V1__initial_schema.sql
├── V2__add_user_email_index.sql
├── V3__expand_add_date_of_birth.sql    ← Phase 1 (expand)
├── V4__migrate_date_of_birth.sql       ← Phase 2 (backfill)
└── V5__drop_dob_column.sql             ← Phase 4 (contract, deployed weeks later)
```

**Decoupling migrations from application deployment:** The expand and backfill migrations (V3, V4) deploy with the application version that writes to both columns. The contract migration (V5) deploys with a later application version after the old code is fully retired.

```yaml
# In the CI pipeline: run migrations BEFORE deploying new application code
# This ensures the schema is compatible with both old and new code
# during the rolling update window.
jobs:
  migrate:
    runs-on: ubuntu-22.04
    steps:
      - name: Run database migrations
        run: |
          # flyway migrate: applies all pending versioned migrations in order
          # --url: database JDBC URL
          # --outOfOrder=false: fail if migrations are applied out of order
          flyway migrate \
            -url="${{ secrets.DATABASE_URL }}" \
            -user="${{ secrets.DB_USER }}" \
            -password="${{ secrets.DB_PASSWORD }}" \
            -locations=filesystem:./migrations \
            -outOfOrder=false \
            -validateOnMigrate=true

  deploy:
    needs: migrate   # MUST run migrations before deploying new code
    runs-on: ubuntu-22.04
    steps:
      - name: Deploy application
        run: kubectl set image deployment/patient-api api=myregistry.io/patient-api:${{ github.sha }}
```

---

## gh-ost: Online Schema Changes for Large Tables

For tables with millions of rows, `ALTER TABLE` operations lock the table for the duration of the migration. On a 50-million-row table, an `ALTER TABLE ... ADD COLUMN` can lock the table for 10–30 minutes. gh-ost (GitHub Online Schema Migration) eliminates this lock.

gh-ost works by:
1. Creating a ghost (shadow) table with the new schema
2. Streaming binlog events from the primary to apply writes to the ghost table in real time
3. Copying rows from the original table to the ghost table in small batches
4. When the ghost table catches up: swap the tables atomically with a brief lock (<1 second)
5. Dropping the old table

```bash
# gh-ost: add a new column to a 50M-row table without downtime
gh-ost \
  --host="db.production.internal" \
  --port=3306 \
  --user="gh-ost" \
  --password="${DB_PASSWORD}" \
  --database="patient_data" \
  --table="patient_records" \
  # The ALTER statement — gh-ost applies this to the ghost table
  --alter="ADD COLUMN date_of_birth DATE DEFAULT NULL" \
  \
  # --throttle-control-replicas: pause copying if replica lag exceeds this
  --throttle-control-replicas="replica1.db.internal,replica2.db.internal" \
  --max-lag-millis=1500 \
  \
  # --chunk-size: rows copied per batch (tune based on row size and I/O capacity)
  --chunk-size=1000 \
  \
  # --cut-over-lock-timeout-seconds: max time for the final table swap lock
  # If the lock can't be acquired within this time, gh-ost retries later
  --cut-over-lock-timeout-seconds=3 \
  \
  # --ok-to-drop-table: after swap, drop the old table
  --ok-to-drop-table \
  \
  # --execute: actually run (omit for dry run)
  --execute

# Output: gh-ost logs progress, estimated completion time, and replica lag.
# It can be paused and resumed safely at any point.
# The migration can run for hours on large tables with zero application disruption.
```

**When to use gh-ost vs. standard ALTER:**
- Table < 10M rows and maintenance window available: standard `ALTER TABLE`
- Table > 10M rows or zero-downtime required: gh-ost (MySQL) or `pg_repack` / `CREATE INDEX CONCURRENTLY` (PostgreSQL)

---

## The NOT NULL Constraint Trap

Adding a NOT NULL column to an existing table is one of the most common backward-compatibility violations. The sequence matters enormously:

```sql
-- ❌ WRONG: NOT NULL with no default — fails for any existing rows
-- Also: any old application version that inserts without this column will fail
ALTER TABLE orders ADD COLUMN tax_rate DECIMAL(5,4) NOT NULL;

-- ❌ WRONG: NOT NULL with default in one migration — still dangerous
-- Old application code that does INSERT INTO orders (col1, col2) VALUES (...)
-- without specifying tax_rate will fail because the old code doesn't know about the column
ALTER TABLE orders ADD COLUMN tax_rate DECIMAL(5,4) NOT NULL DEFAULT 0.0;

-- ✅ CORRECT: Three-phase approach
-- Migration 1 (Phase 1 - Expand): nullable column with default
ALTER TABLE orders ADD COLUMN tax_rate DECIMAL(5,4) DEFAULT 0.0;
-- Old code: ignores tax_rate (column exists but nullable — no insert failure)
-- New code: writes tax_rate explicitly

-- Migration 2 (Phase 2 - Backfill): fill historical rows
UPDATE orders SET tax_rate = 0.0 WHERE tax_rate IS NULL;

-- Migration 3 (Phase 4 - Contract): add NOT NULL constraint
-- Deploy ONLY after all old code is retired
ALTER TABLE orders ALTER COLUMN tax_rate SET NOT NULL;
-- At this point: old code is gone, no inserts will omit tax_rate
```

---

## The Rollback Problem: What's Actually Reversible

The hardest truth about database migrations: **they are often not reversible**. Once data has been written to a new schema, rolling back the schema requires migrating that data back — which may not be possible if data was deleted, if new data doesn't fit the old schema constraints, or if the migration was destructive.

```
Migration type          Reversible?  Notes
────────────────────────────────────────────────────────
ADD COLUMN (nullable)   ✅ Yes       DROP COLUMN (if no data was written to it yet)
ADD COLUMN + backfill   ⚠️ Partially  DROP COLUMN loses the backfilled data
DROP COLUMN             ❌ No        Data is gone (unless backup available)
RENAME COLUMN           ⚠️ Partially  Rename back, but any writes to new name are in old name
ADD INDEX               ✅ Yes       DROP INDEX
ADD NOT NULL CONSTRAINT ⚠️ Partially  Can remove constraint, but requires all rows to be valid first
CHANGE COLUMN TYPE      ❌ Usually   Type coercion may be lossy (TEXT → VARCHAR(50) truncates)
```

The implication for pipeline design: **rollback in the traditional sense (redeploy previous binary) doesn't work for destructive migrations**. The pipeline must:
1. Prevent destructive migrations from running until the roll-forward path is verified
2. Require explicit human approval for the contract phase (dropping columns)
3. Treat the contract phase as a separate deployment with a longer observation window

---

## Scale Considerations

**At <1M rows per table:** Standard `ALTER TABLE` migrations are fast enough to run in a deployment pipeline without causing noticeable downtime. Expand-and-Contract is still good practice but the window is seconds, not minutes.

**At 1M–50M rows:** ALTER TABLE on MySQL can lock for minutes. Use gh-ost (MySQL) or `CREATE TABLE ... SELECT` + swap pattern (PostgreSQL with pg_repack) for tables in the 1M+ range.

**At 50M+ rows:** gh-ost or equivalent is mandatory. Migrations may run for hours. They should run as background jobs, not as pipeline steps, with progress monitoring in Datadog and the ability to pause/resume without impact.

---

## The Anti-Patterns

### ❌ Anti-Pattern: Migrations in Application Init Containers

**What it looks like:** `flyway migrate` runs in a Kubernetes init container before the application starts. During a rolling deploy, the init container on the first new pod runs the migration before old pods have drained.

**What breaks:** Old pods still running may have incompatible code for the new schema, causing errors during the drain window.

**The fix:** Run migrations as a separate Kubernetes Job before the deployment rollout, not in the init container. The Job must complete before the Deployment rollout begins.

---

### ❌ Anti-Pattern: Single-Migration Column Rename

**What it looks like:** `ALTER TABLE t RENAME COLUMN old TO new` — one migration, one deployment.

**What breaks:** Any old code reading the old column name during a rolling update window fails immediately. This is exactly the Meridian Health incident.

**The fix:** Expand-and-Contract: new column + dual-write + backfill + read from new + drop old. Four phases, multiple deployments, zero downtime.

---

## Field Notes

💀 **Schema migration in init container** → Old pods crash during rolling update window → Run migrations as a pre-deployment Job. The Job gates the deployment rollout.

💀 **NOT NULL column added without backfill phase** → Any INSERT from old code that doesn't include the new column fails → Three-phase: nullable first, backfill second, NOT NULL constraint third (separate deployment after old code retired).

💀 **Assuming migrations are always fast** → 50M-row table, ALTER TABLE, 18-minute table lock, production down → Profile table sizes before writing migrations. Anything over 1M rows needs gh-ost or equivalent.

---

## Chapter Summary

Database migrations are the deployment constraint that most engineering teams learn about through pain. The Expand-and-Contract pattern eliminates the pain by separating schema evolution into discrete phases that maintain backward compatibility throughout. The price is calendar time: a column rename that takes one migration on a single-instance system takes three migrations and three deployments on a rolling-update system. That price is worth paying. The alternative is a 90-second window where 400 patient record reads fail in a healthcare application.

---

## What's Next

Chapter 28 applies a similar promotion-based thinking to infrastructure: Terraform plans as promotable artifacts, plan review as a required gate, and drift detection as the equivalent of "does the cluster match what GitOps says it should?"

[→ Next: Chapter 28 — The IaC Promotion Pattern](./chapter-28-iac-promotion.md)

---
*[← Previous: Chapter 26 — The On-Call & Incident-Driven Release Feedback Pattern](../part-05-observability-feedback/chapter-26-oncall-incident-feedback.md) |
[→ Next: Chapter 28 — The IaC Promotion Pattern](./chapter-28-iac-promotion.md)*

/**
 * Migration 007: Create cluster_metrics time-series table
 */

import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS _tenant.cluster_metrics (
      id BIGSERIAL PRIMARY KEY,
      cluster_id INTEGER NOT NULL REFERENCES _tenant.db_instances(id) ON DELETE CASCADE,
      timestamp TIMESTAMPTZ NOT NULL,
      max_databases INTEGER NOT NULL,
      current_databases INTEGER NOT NULL,
      utilization_percentage NUMERIC(5,2) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_cluster_metrics_cluster_time
      ON _tenant.cluster_metrics(cluster_id, timestamp DESC)
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_cluster_metrics_timestamp
      ON _tenant.cluster_metrics(timestamp DESC)
  `.execute(db)

  // Cleanup function for old metrics
  await sql`
    CREATE OR REPLACE FUNCTION _tenant.cleanup_old_metrics(retention_days INTEGER DEFAULT 30)
    RETURNS TABLE(deleted_count BIGINT) AS $$
    DECLARE rows_deleted BIGINT;
    BEGIN
      DELETE FROM _tenant.cluster_metrics
      WHERE created_at < NOW() - (retention_days || ' days')::INTERVAL;
      GET DIAGNOSTICS rows_deleted = ROW_COUNT;
      RETURN QUERY SELECT rows_deleted;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP FUNCTION IF EXISTS _tenant.cleanup_old_metrics(INTEGER)`.execute(db)
  await sql`DROP TABLE IF EXISTS _tenant.cluster_metrics`.execute(db)
}

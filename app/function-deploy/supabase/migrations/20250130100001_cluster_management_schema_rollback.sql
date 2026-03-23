-- Rollback Migration: Database Cluster Management Schema
-- Description: Drops _studio schema tables and related objects
-- This migration reverses: 20250130100000_cluster_management_schema.sql

-- Unschedule pg_cron job if it exists
-- Note: This requires pg_cron extension to be installed
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('cleanup-cluster-metrics');
  END IF;
EXCEPTION
  WHEN OTHERS THEN
    -- Ignore errors if pg_cron is not installed or job doesn't exist
    NULL;
END $$;

-- Drop cleanup function
DROP FUNCTION IF EXISTS _studio.cleanup_old_metrics(INTEGER);

-- Drop cluster_metrics table and its indexes
-- Note: Must be dropped before db_instances due to foreign key constraint
DROP TABLE IF EXISTS _studio.cluster_metrics CASCADE;

-- Drop indexes for cluster_metrics (will be dropped with table, but explicit for clarity)
DROP INDEX IF EXISTS _studio.idx_cluster_metrics_timestamp;
DROP INDEX IF EXISTS _studio.idx_cluster_metrics_cluster_time;

-- Drop triggers
DROP TRIGGER IF EXISTS update_allocation_strategies_updated_at ON _studio.project_allocation_strategies;
DROP TRIGGER IF EXISTS update_db_instances_updated_at ON _studio.db_instances;

-- Drop trigger function
DROP FUNCTION IF EXISTS _studio.update_updated_at_column();

-- Drop indexes (will be dropped automatically with tables, but explicit for clarity)
DROP INDEX IF EXISTS _studio.idx_allocation_strategies_active;
DROP INDEX IF EXISTS _studio.idx_db_instances_region;
DROP INDEX IF EXISTS _studio.idx_db_instances_status;
DROP INDEX IF EXISTS _studio.idx_db_instances_host;

-- Drop tables
DROP TABLE IF EXISTS _studio.project_allocation_strategies CASCADE;
DROP TABLE IF EXISTS _studio.db_instances CASCADE;

-- Drop schema (only if empty)
-- Note: This will fail if other objects exist in the schema
-- Use DROP SCHEMA _studio CASCADE; to force drop with all objects
DROP SCHEMA IF EXISTS _studio;


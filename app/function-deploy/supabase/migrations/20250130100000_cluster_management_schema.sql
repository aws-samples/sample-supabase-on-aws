-- Migration: Database Cluster Management Schema
-- Description: Creates _studio schema with db_instances and project_allocation_strategies tables
-- Requirements: 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 3.3

-- Create _studio schema if it doesn't exist
CREATE SCHEMA IF NOT EXISTS _studio;

-- Create db_instances table
CREATE TABLE _studio.db_instances (
  id SERIAL PRIMARY KEY,
  identifier VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  host VARCHAR(255) NOT NULL,
  port INTEGER DEFAULT 5432,
  admin_user VARCHAR(128) DEFAULT 'postgres',
  auth_method VARCHAR(32) NOT NULL DEFAULT 'password' 
    CHECK (auth_method IN ('password', 'secrets_manager')),
  admin_credential TEXT,
  is_management_instance BOOLEAN DEFAULT FALSE,
  region VARCHAR(64) DEFAULT 'default',
  status VARCHAR(32) DEFAULT 'offline' 
    CHECK (status IN ('online', 'offline', 'maintenance')),
  weight INTEGER DEFAULT 100,
  max_databases INTEGER DEFAULT 10000,
  current_databases INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for db_instances
CREATE INDEX idx_db_instances_host ON _studio.db_instances(host);
CREATE INDEX idx_db_instances_status ON _studio.db_instances(status);
CREATE INDEX idx_db_instances_region ON _studio.db_instances(region);

-- Create project_allocation_strategies table
CREATE TABLE _studio.project_allocation_strategies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL UNIQUE,
  strategy_type VARCHAR(50) NOT NULL 
    CHECK (strategy_type IN ('manual', 'hash', 'round_robin', 
                              'weighted_round_robin', 'least_connections')),
  description TEXT,
  config JSONB,
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create index for project_allocation_strategies
CREATE INDEX idx_allocation_strategies_active ON _studio.project_allocation_strategies(is_active);

-- Create trigger function to update updated_at timestamp
CREATE OR REPLACE FUNCTION _studio.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for db_instances updated_at
CREATE TRIGGER update_db_instances_updated_at
  BEFORE UPDATE ON _studio.db_instances
  FOR EACH ROW
  EXECUTE FUNCTION _studio.update_updated_at_column();

-- Create trigger for project_allocation_strategies updated_at
CREATE TRIGGER update_allocation_strategies_updated_at
  BEFORE UPDATE ON _studio.project_allocation_strategies
  FOR EACH ROW
  EXECUTE FUNCTION _studio.update_updated_at_column();

-- Add comments for documentation
COMMENT ON SCHEMA _studio IS 'Schema for Studio internal metadata and configuration';
COMMENT ON TABLE _studio.db_instances IS 'Stores configuration and state for managed database clusters';
COMMENT ON TABLE _studio.project_allocation_strategies IS 'Stores allocation strategy configurations for project distribution';

COMMENT ON COLUMN _studio.db_instances.identifier IS 'Unique cluster identifier used in API calls';
COMMENT ON COLUMN _studio.db_instances.auth_method IS 'Authentication method: password (encrypted) or secrets_manager (external reference)';
COMMENT ON COLUMN _studio.db_instances.admin_credential IS 'Encrypted password or secret reference depending on auth_method';
COMMENT ON COLUMN _studio.db_instances.is_management_instance IS 'Flag indicating if this is the metadata database itself';
COMMENT ON COLUMN _studio.db_instances.status IS 'Current operational status: online, offline, or maintenance';
COMMENT ON COLUMN _studio.db_instances.weight IS 'Weight value for weighted allocation strategies';
COMMENT ON COLUMN _studio.db_instances.max_databases IS 'Maximum number of databases this cluster can host';
COMMENT ON COLUMN _studio.db_instances.current_databases IS 'Current number of databases hosted on this cluster';

COMMENT ON COLUMN _studio.project_allocation_strategies.strategy_type IS 'Algorithm type: manual, hash, round_robin, weighted_round_robin, or least_connections';
COMMENT ON COLUMN _studio.project_allocation_strategies.config IS 'Strategy-specific configuration stored as JSON';
COMMENT ON COLUMN _studio.project_allocation_strategies.is_active IS 'Whether this strategy is currently active for project allocation';

-- Create cluster_metrics table for time-series monitoring data
-- Requirements: 18.1, 18.2
CREATE TABLE _studio.cluster_metrics (
  id BIGSERIAL PRIMARY KEY,
  cluster_id INTEGER NOT NULL REFERENCES _studio.db_instances(id) ON DELETE CASCADE,
  timestamp TIMESTAMPTZ NOT NULL,
  max_databases INTEGER NOT NULL,
  current_databases INTEGER NOT NULL,
  utilization_percentage NUMERIC(5,2) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for efficient time-series queries
CREATE INDEX idx_cluster_metrics_cluster_time 
  ON _studio.cluster_metrics(cluster_id, timestamp DESC);

CREATE INDEX idx_cluster_metrics_timestamp 
  ON _studio.cluster_metrics(timestamp DESC);

-- Add comments for cluster_metrics table
COMMENT ON TABLE _studio.cluster_metrics IS 'Stores historical capacity and utilization metrics for monitoring charts';
COMMENT ON COLUMN _studio.cluster_metrics.cluster_id IS 'Foreign key reference to db_instances, cascades on delete';
COMMENT ON COLUMN _studio.cluster_metrics.timestamp IS 'Time when the metrics were collected';
COMMENT ON COLUMN _studio.cluster_metrics.max_databases IS 'Cluster capacity at this timestamp';
COMMENT ON COLUMN _studio.cluster_metrics.current_databases IS 'Number of databases in use at this timestamp';
COMMENT ON COLUMN _studio.cluster_metrics.utilization_percentage IS 'Calculated utilization percentage (0.00-100.00)';
COMMENT ON COLUMN _studio.cluster_metrics.created_at IS 'Timestamp when the record was inserted into the database';

-- ============================================================================
-- DATA RETENTION POLICY
-- ============================================================================

-- Create function to clean up old metrics data
CREATE OR REPLACE FUNCTION _studio.cleanup_old_metrics(retention_days INTEGER DEFAULT 30)
RETURNS TABLE(deleted_count BIGINT) AS $$
DECLARE
  rows_deleted BIGINT;
BEGIN
  -- Delete metrics older than retention period
  DELETE FROM _studio.cluster_metrics
  WHERE created_at < NOW() - (retention_days || ' days')::INTERVAL;
  
  GET DIAGNOSTICS rows_deleted = ROW_COUNT;
  
  -- Log the cleanup operation
  RAISE NOTICE 'Deleted % old metric records (retention: % days)', rows_deleted, retention_days;
  
  RETURN QUERY SELECT rows_deleted;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION _studio.cleanup_old_metrics IS 'Deletes cluster metrics older than the specified retention period (default: 30 days)';

-- ============================================================================
-- AUTOMATIC CLEANUP WITH PG_CRON (Optional)
-- ============================================================================
-- Uncomment the following lines if pg_cron extension is available:
--
-- -- Enable pg_cron extension (requires superuser)
-- CREATE EXTENSION IF NOT EXISTS pg_cron;
--
-- -- Schedule daily cleanup at 2 AM
-- SELECT cron.schedule(
--   'cleanup-cluster-metrics',           -- job name
--   '0 2 * * *',                         -- cron schedule (2 AM daily)
--   $$ SELECT _studio.cleanup_old_metrics(30); $$
-- );
--
-- -- To view scheduled jobs:
-- -- SELECT * FROM cron.job;
--
-- -- To unschedule the job:
-- -- SELECT cron.unschedule('cleanup-cluster-metrics');
--
-- ============================================================================

-- Alternative: Manual cleanup can be triggered by calling:
-- SELECT _studio.cleanup_old_metrics(30);  -- Delete data older than 30 days

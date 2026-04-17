-- Edge Functions Metadata Storage
-- Stores metadata for Edge Functions to improve performance and enable complex queries
-- This is platform-level metadata, stored in _studio schema (not replicated to template databases)

-- Edge Functions metadata table in _studio schema (platform-level)
CREATE TABLE IF NOT EXISTS _studio.edge_functions_metadata (
  -- Using UUID as primary key for better distributed system compatibility
  -- UUID avoids ID conflicts in multi-node deployments and doesn't expose record count
  -- The real business key is (project_ref, slug) which has a unique constraint
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_ref TEXT NOT NULL,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  version TEXT NOT NULL DEFAULT '1.0.0',
  runtime TEXT NOT NULL DEFAULT 'deno',
  entrypoint TEXT NOT NULL DEFAULT 'index.ts',
  user_id TEXT,
  deployment_source TEXT DEFAULT 'unknown',
  metadata_loaded BOOLEAN DEFAULT false,
  metadata_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  -- Additional metadata as JSONB for flexibility
  extra_metadata JSONB DEFAULT '{}'::jsonb,
  
  -- Unique constraint on project_ref + slug (the real business key)
  CONSTRAINT edge_functions_metadata_unique UNIQUE (project_ref, slug)
);

-- Create indexes for common queries
CREATE INDEX IF NOT EXISTS idx_edge_functions_metadata_project_ref 
  ON _studio.edge_functions_metadata(project_ref);

CREATE INDEX IF NOT EXISTS idx_edge_functions_metadata_slug 
  ON _studio.edge_functions_metadata(slug);

CREATE INDEX IF NOT EXISTS idx_edge_functions_metadata_created_at 
  ON _studio.edge_functions_metadata(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_edge_functions_metadata_updated_at 
  ON _studio.edge_functions_metadata(updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_edge_functions_metadata_deployment_source 
  ON _studio.edge_functions_metadata(deployment_source);

-- Index for filtering by metadata_loaded (used by list/exists/getMetadata queries)
CREATE INDEX IF NOT EXISTS idx_edge_functions_metadata_loaded 
  ON _studio.edge_functions_metadata(project_ref, metadata_loaded) 
  WHERE metadata_loaded = true;

-- Create GIN index for JSONB queries
CREATE INDEX IF NOT EXISTS idx_edge_functions_metadata_extra_metadata 
  ON _studio.edge_functions_metadata USING GIN (extra_metadata);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION _studio.update_edge_functions_metadata_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to automatically update updated_at
CREATE TRIGGER update_edge_functions_metadata_updated_at
  BEFORE UPDATE ON _studio.edge_functions_metadata
  FOR EACH ROW
  EXECUTE FUNCTION _studio.update_edge_functions_metadata_updated_at();

-- Grant permissions
-- This table should only be accessed by backend services (Studio API), not by end users
-- _studio schema is platform-level and not replicated to template databases

-- Studio uses supabase_admin role to connect to the database
-- Grant full access to supabase_admin for CRUD operations
GRANT SELECT, INSERT, UPDATE, DELETE ON _studio.edge_functions_metadata TO supabase_admin;

-- Also grant to service_role for API access (if needed by other services)
GRANT SELECT, INSERT, UPDATE, DELETE ON _studio.edge_functions_metadata TO service_role;

-- postgres superuser already has all permissions by default
-- No need to explicitly grant to postgres

-- Do NOT grant access to authenticated or anon roles
-- End users should access Edge Functions through the API, not directly through the database

-- Note: _studio schema is already owned by supabase_admin, so schema-level permissions are inherited

-- Comments for documentation
COMMENT ON TABLE _studio.edge_functions_metadata IS 'Platform-level metadata for Edge Functions (not replicated to template databases)';
COMMENT ON COLUMN _studio.edge_functions_metadata.project_ref IS 'Project reference identifier';
COMMENT ON COLUMN _studio.edge_functions_metadata.slug IS 'Function slug/identifier';
COMMENT ON COLUMN _studio.edge_functions_metadata.name IS 'Human-readable function name';
COMMENT ON COLUMN _studio.edge_functions_metadata.version IS 'Function version (semver)';
COMMENT ON COLUMN _studio.edge_functions_metadata.runtime IS 'Runtime environment (e.g., deno)';
COMMENT ON COLUMN _studio.edge_functions_metadata.entrypoint IS 'Entry point file path';
COMMENT ON COLUMN _studio.edge_functions_metadata.deployment_source IS 'Source of deployment (ui, api, cli, unknown)';
COMMENT ON COLUMN _studio.edge_functions_metadata.extra_metadata IS 'Additional metadata as JSON';

-- Migration: Create studio_projects table
-- Description: Creates the studio_projects table for storing project metadata in _studio schema

-- Create _studio schema if it doesn't exist
CREATE SCHEMA IF NOT EXISTS _studio;

-- Create studio_projects table in _studio schema
CREATE TABLE IF NOT EXISTS _studio.studio_projects (
  id BIGSERIAL PRIMARY KEY,
  ref VARCHAR(255) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  database_name VARCHAR(255) NOT NULL,
  database_user VARCHAR(255),
  database_password_hash TEXT,
  organization_id INTEGER NOT NULL,
  owner_user_id VARCHAR(255),
  status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE_HEALTHY'
    CHECK (status IN ('ACTIVE_HEALTHY', 'INACTIVE', 'COMING_UP', 'UNKNOWN', 'REMOVED')),
  region VARCHAR(100) DEFAULT 'default',
  connection_string TEXT,
  inserted_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_studio_projects_ref ON _studio.studio_projects(ref);
CREATE INDEX IF NOT EXISTS idx_studio_projects_organization ON _studio.studio_projects(organization_id);
CREATE INDEX IF NOT EXISTS idx_studio_projects_owner ON _studio.studio_projects(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_studio_projects_status ON _studio.studio_projects(status);

-- Create trigger for updated_at
CREATE OR REPLACE FUNCTION _studio.update_studio_projects_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_studio_projects_updated_at
  BEFORE UPDATE ON _studio.studio_projects
  FOR EACH ROW
  EXECUTE FUNCTION _studio.update_studio_projects_updated_at();

-- Add comments
COMMENT ON TABLE _studio.studio_projects IS 'Stores project metadata for Supabase Studio';
COMMENT ON COLUMN _studio.studio_projects.ref IS 'Unique project reference identifier';
COMMENT ON COLUMN _studio.studio_projects.database_name IS 'Name of the project database';
COMMENT ON COLUMN _studio.studio_projects.database_user IS 'Project-specific database user';
COMMENT ON COLUMN _studio.studio_projects.database_password_hash IS 'Hashed password for the database user';
COMMENT ON COLUMN _studio.studio_projects.organization_id IS 'Organization that owns this project';
COMMENT ON COLUMN _studio.studio_projects.owner_user_id IS 'User ID of the project owner';
COMMENT ON COLUMN _studio.studio_projects.status IS 'Current project status';
COMMENT ON COLUMN _studio.studio_projects.connection_string IS 'Database connection string';

-- Insert default project for local development
INSERT INTO _studio.studio_projects (
  ref,
  name,
  database_name,
  database_user,
  organization_id,
  owner_user_id,
  status,
  region,
  connection_string
) VALUES (
  'default',
  'Default Project',
  'postgres',
  'postgres',
  1,
  'local-dev-user',
  'ACTIVE_HEALTHY',
  'local',
  'postgresql://postgres:your-super-secret-and-long-postgres-password@localhost:5432/postgres'
) ON CONFLICT (ref) DO NOTHING;

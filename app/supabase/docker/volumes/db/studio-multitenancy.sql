-- Studio Multitenancy Schema
-- Creates _studio schema in _supabase database for managing multiple projects

\c _supabase

CREATE SCHEMA IF NOT EXISTS _studio;

-- Database instances table (for multi-instance support)
CREATE TABLE IF NOT EXISTS _studio.db_instances (
    id SERIAL PRIMARY KEY,
    identifier VARCHAR(64) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    host VARCHAR(255) NOT NULL,
    port INTEGER NOT NULL DEFAULT 5432,
    admin_user VARCHAR(128) NOT NULL DEFAULT 'postgres',
    admin_pass_encrypted TEXT,
    is_management_instance BOOLEAN DEFAULT FALSE,
    region VARCHAR(64) DEFAULT 'default',
    status VARCHAR(32) DEFAULT 'active',
    weight INTEGER DEFAULT 100,
    max_databases INTEGER DEFAULT 100,
    current_databases INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT db_instances_status_valid CHECK (status IN ('active', 'maintenance', 'draining', 'offline'))
);

-- Projects table
CREATE TABLE IF NOT EXISTS _studio.projects (
    id SERIAL PRIMARY KEY,
    ref VARCHAR(64) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,

    -- Database connection
    db_instance_id INTEGER REFERENCES _studio.db_instances(id),
    db_host VARCHAR(255) DEFAULT 'db',
    db_port INTEGER DEFAULT 5432,
    db_name VARCHAR(128) NOT NULL,

    -- API configuration (stored encrypted)
    jwt_secret TEXT,
    anon_key TEXT,
    service_role_key TEXT,

    -- Status
    status VARCHAR(32) DEFAULT 'COMING_UP',
    creation_status TEXT DEFAULT 'pending',

    -- Service ports (for PostgREST/Auth independent containers)
    rest_port INTEGER,
    auth_port INTEGER,

    -- Metadata
    cloud_provider VARCHAR(64) DEFAULT 'localhost',
    region VARCHAR(64) DEFAULT 'local',
    organization_id INTEGER DEFAULT 1,

    inserted_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    CONSTRAINT projects_ref_format CHECK (ref ~ '^[a-z0-9-]+$')
);

-- Project quotas table (optional)
CREATE TABLE IF NOT EXISTS _studio.project_quotas (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES _studio.projects(id) ON DELETE CASCADE,
    db_size_limit_bytes BIGINT DEFAULT 536870912,
    storage_size_limit_bytes BIGINT DEFAULT 1073741824,
    api_requests_per_day INTEGER DEFAULT 100000,
    UNIQUE(project_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_projects_ref ON _studio.projects(ref);
CREATE INDEX IF NOT EXISTS idx_projects_status ON _studio.projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_instance ON _studio.projects(db_instance_id);
CREATE INDEX IF NOT EXISTS idx_db_instances_status ON _studio.db_instances(status);

-- Trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION _studio.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_projects_updated_at ON _studio.projects;
CREATE TRIGGER update_projects_updated_at
    BEFORE UPDATE ON _studio.projects
    FOR EACH ROW
    EXECUTE FUNCTION _studio.update_updated_at_column();

-- Insert default management instance
INSERT INTO _studio.db_instances (identifier, name, host, port, is_management_instance)
VALUES ('default', 'Default Instance', 'db', 5432, TRUE)
ON CONFLICT (identifier) DO NOTHING;

-- Insert default project (references the default postgres database)
INSERT INTO _studio.projects (id, ref, name, db_name, db_instance_id, status, creation_status)
VALUES (1, 'default', 'Default Project', 'postgres', 1, 'ACTIVE_HEALTHY', 'completed')
ON CONFLICT (ref) DO NOTHING;

/**
 * Migration 002: Create projects table
 */

import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS _tenant.projects (
      id SERIAL PRIMARY KEY,
      ref VARCHAR(64) NOT NULL UNIQUE,
      name VARCHAR(255) NOT NULL,
      db_instance_id INTEGER NOT NULL DEFAULT 1,
      db_host VARCHAR(255) NOT NULL DEFAULT 'db',
      db_port INTEGER NOT NULL DEFAULT 5432,
      db_name VARCHAR(255) NOT NULL,
      jwt_secret TEXT,
      anon_key TEXT,
      service_role_key TEXT,
      status VARCHAR(32) NOT NULL DEFAULT 'COMING_UP',
      creation_status TEXT NOT NULL DEFAULT 'pending',
      rest_port INTEGER,
      auth_port INTEGER,
      cloud_provider VARCHAR(64) NOT NULL DEFAULT 'self-hosted',
      region VARCHAR(64) NOT NULL DEFAULT 'default',
      organization_id INTEGER NOT NULL DEFAULT 1,
      inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_projects_status ON _tenant.projects(status)
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_projects_db_instance_id ON _tenant.projects(db_instance_id)
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_projects_organization_id ON _tenant.projects(organization_id)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS _tenant.projects`.execute(db)
}

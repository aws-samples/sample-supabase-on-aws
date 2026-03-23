/**
 * Migration 003: Create db_instances table
 */

import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS _tenant.db_instances (
      id SERIAL PRIMARY KEY,
      identifier VARCHAR(64) NOT NULL UNIQUE,
      name VARCHAR(255) NOT NULL,
      host VARCHAR(255) NOT NULL,
      port INTEGER NOT NULL DEFAULT 5432,
      admin_user VARCHAR(128) NOT NULL DEFAULT 'postgres',
      admin_pass_encrypted TEXT,
      is_management_instance BOOLEAN NOT NULL DEFAULT false,
      region VARCHAR(64) NOT NULL DEFAULT 'default',
      status VARCHAR(32) NOT NULL DEFAULT 'active',
      weight INTEGER NOT NULL DEFAULT 100,
      max_databases INTEGER NOT NULL DEFAULT 100,
      current_databases INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_db_instances_status ON _tenant.db_instances(status)
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_db_instances_region ON _tenant.db_instances(region)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS _tenant.db_instances`.execute(db)
}

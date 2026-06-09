/**
 * Migration 008: Create _tenant.functions table for Edge Function metadata.
 *
 * Phase 2 §2 — verify_jwt is per-function gateway-layer config. Studio writes
 * here via tenant-manager; Kong pre-function reads it (via the internal
 * lookup endpoint, optionally cached in Redis) to decide whether the
 * request must carry a valid apikey/JWT.
 *
 * Composite primary key (project_ref, slug) keeps lookups fast and matches
 * the canonical Supabase identity (a function is identified by its slug
 * within a project).
 */

import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS _tenant.functions (
      project_ref VARCHAR(64) NOT NULL,
      slug VARCHAR(128) NOT NULL,
      name VARCHAR(255),
      verify_jwt BOOLEAN NOT NULL DEFAULT TRUE,
      import_map BOOLEAN NOT NULL DEFAULT FALSE,
      lambda_arn TEXT,
      inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (project_ref, slug)
    )
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_functions_project_ref
      ON _tenant.functions(project_ref)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS _tenant.functions`.execute(db)
}

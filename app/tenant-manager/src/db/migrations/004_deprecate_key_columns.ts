/**
 * Migration 004: Drop legacy key columns from projects table
 * Keys are now exclusively stored in AWS Secrets Manager.
 */

import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE _tenant.projects
      DROP COLUMN IF EXISTS jwt_secret,
      DROP COLUMN IF EXISTS anon_key,
      DROP COLUMN IF EXISTS service_role_key
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE _tenant.projects
      ADD COLUMN IF NOT EXISTS jwt_secret TEXT,
      ADD COLUMN IF NOT EXISTS anon_key TEXT,
      ADD COLUMN IF NOT EXISTS service_role_key TEXT
  `.execute(db)
}

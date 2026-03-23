/**
 * Migration 005: Add auth_method and admin_credential columns to db_instances
 * Replaces admin_pass_encrypted with dual-mode credential support
 */

import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  // Add auth_method column
  await sql`
    ALTER TABLE _tenant.db_instances
    ADD COLUMN IF NOT EXISTS auth_method VARCHAR(32) NOT NULL DEFAULT 'password'
      CHECK (auth_method IN ('password', 'secrets_manager'))
  `.execute(db)

  // Add admin_credential column
  await sql`
    ALTER TABLE _tenant.db_instances
    ADD COLUMN IF NOT EXISTS admin_credential TEXT
  `.execute(db)

  // Migrate existing data: copy admin_pass_encrypted to admin_credential
  await sql`
    UPDATE _tenant.db_instances
    SET admin_credential = admin_pass_encrypted
    WHERE admin_pass_encrypted IS NOT NULL
      AND admin_credential IS NULL
  `.execute(db)

  // Drop the old column
  await sql`
    ALTER TABLE _tenant.db_instances
    DROP COLUMN IF EXISTS admin_pass_encrypted
  `.execute(db)

  // Add updated_at column (was missing from original schema)
  await sql`
    ALTER TABLE _tenant.db_instances
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Re-add admin_pass_encrypted column
  await sql`
    ALTER TABLE _tenant.db_instances
    ADD COLUMN IF NOT EXISTS admin_pass_encrypted TEXT
  `.execute(db)

  // Migrate data back for password-type credentials
  await sql`
    UPDATE _tenant.db_instances
    SET admin_pass_encrypted = admin_credential
    WHERE auth_method = 'password'
      AND admin_credential IS NOT NULL
  `.execute(db)

  // Drop new columns
  await sql`
    ALTER TABLE _tenant.db_instances
    DROP COLUMN IF EXISTS admin_credential
  `.execute(db)

  await sql`
    ALTER TABLE _tenant.db_instances
    DROP COLUMN IF EXISTS auth_method
  `.execute(db)

  await sql`
    ALTER TABLE _tenant.db_instances
    DROP COLUMN IF EXISTS updated_at
  `.execute(db)
}

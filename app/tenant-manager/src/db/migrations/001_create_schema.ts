/**
 * Migration 001: Create _tenant schema
 */

import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE SCHEMA IF NOT EXISTS _tenant`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP SCHEMA IF EXISTS _tenant CASCADE`.execute(db)
}

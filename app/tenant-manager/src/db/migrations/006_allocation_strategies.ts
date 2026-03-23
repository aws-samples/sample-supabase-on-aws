/**
 * Migration 006: Create project_allocation_strategies table
 */

import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS _tenant.project_allocation_strategies (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(255) NOT NULL UNIQUE,
      strategy_type VARCHAR(50) NOT NULL
        CHECK (strategy_type IN ('manual', 'hash', 'round_robin',
               'weighted_round_robin', 'least_connections', 'region_affinity')),
      description TEXT,
      config JSONB,
      is_active BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_allocation_strategies_active
      ON _tenant.project_allocation_strategies(is_active)
  `.execute(db)

  // Insert default strategy
  await sql`
    INSERT INTO _tenant.project_allocation_strategies (name, strategy_type, description, is_active)
    VALUES ('default-least-connections', 'least_connections', 'Default: select instance with lowest utilization', true)
    ON CONFLICT (name) DO NOTHING
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS _tenant.project_allocation_strategies`.execute(db)
}

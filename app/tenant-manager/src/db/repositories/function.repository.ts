/**
 * Edge Function metadata repository.
 *
 * Powers the `_tenant.functions` table: per-function gateway-layer config
 * (verify_jwt, etc.) keyed by (project_ref, slug). Kong pre-function reads
 * this via the internal lookup endpoint to decide whether incoming
 * /functions/v1/{slug} requests must carry a valid apikey.
 */

import { sql } from 'kysely'
import { getManagementDb } from '../connection.js'
import type { FunctionRow, NewFunction } from '../types.js'

export async function findFunction(
  projectRef: string,
  slug: string,
): Promise<FunctionRow | null> {
  const db = getManagementDb()
  const row = await db
    .selectFrom('_tenant.functions')
    .selectAll()
    .where('project_ref', '=', projectRef)
    .where('slug', '=', slug)
    .executeTakeFirst()
  return row ?? null
}

export async function listFunctions(projectRef: string): Promise<FunctionRow[]> {
  const db = getManagementDb()
  return db
    .selectFrom('_tenant.functions')
    .selectAll()
    .where('project_ref', '=', projectRef)
    .orderBy('slug', 'asc')
    .execute()
}

export async function upsertFunction(input: NewFunction): Promise<FunctionRow> {
  const db = getManagementDb()
  const row = await db
    .insertInto('_tenant.functions')
    .values({
      ...input,
      updated_at: sql`NOW()` as unknown as Date,
    })
    .onConflict((oc) =>
      oc.columns(['project_ref', 'slug']).doUpdateSet({
        // verify_jwt is the canonical mutable field; if absent in input, keep
        // the existing value via COALESCE to avoid clobbering writes from
        // unrelated PATCH callers.
        verify_jwt: input.verify_jwt ?? sql`_tenant.functions.verify_jwt` as unknown as boolean,
        import_map: input.import_map ?? sql`_tenant.functions.import_map` as unknown as boolean,
        name: input.name ?? sql`_tenant.functions.name` as unknown as string,
        lambda_arn: input.lambda_arn ?? sql`_tenant.functions.lambda_arn` as unknown as string,
        updated_at: sql`NOW()` as unknown as Date,
      })
    )
    .returningAll()
    .executeTakeFirst()
  if (!row) {
    throw new Error(`upsertFunction failed for ${input.project_ref}/${input.slug}`)
  }
  return row
}

export async function deleteFunction(projectRef: string, slug: string): Promise<boolean> {
  const db = getManagementDb()
  const result = await db
    .deleteFrom('_tenant.functions')
    .where('project_ref', '=', projectRef)
    .where('slug', '=', slug)
    .execute()
  const deleted = (result?.[0] as { numDeletedRows?: bigint } | undefined)?.numDeletedRows ?? 0n
  return deleted > 0n
}

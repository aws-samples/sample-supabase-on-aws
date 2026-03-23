/**
 * PostgREST Lambda schema cache reload service.
 *
 * Dual mechanism:
 *   1. NOTIFY pgrst — fast path (works only when LISTEN session is alive)
 *   2. UpdateFunctionConfiguration — guaranteed cold-restart fallback
 */

import {
  LambdaClient,
  UpdateFunctionConfigurationCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-lambda'
import { getEnv } from '../../config/index.js'
import { withTenantClient } from '../../db/connection.js'
import { getPlatformPool } from '../../db/platform-connection.js'

let lambdaClient: LambdaClient | null = null

function getLambdaClient(): LambdaClient {
  if (!lambdaClient) {
    lambdaClient = new LambdaClient({ region: getEnv().AWS_REGION })
  }
  return lambdaClient
}

/**
 * Resolve the tenant database name for a given project ref.
 */
async function getTenantDbName(projectRef: string): Promise<string | null> {
  const pool = getPlatformPool()
  const result = await pool.query<{ db_uri: string }>(
    `SELECT pc.db_uri FROM postgrest_config pc WHERE pc.project_id = $1`,
    [projectRef],
  )
  const row = result.rows[0]
  if (!row) return null

  // db_uri format: postgresql://user:pass@host:port/dbname?params
  try {
    const url = new URL(row.db_uri)
    return url.pathname.replace(/^\//, '')
  } catch {
    return null
  }
}

/**
 * Reload PostgREST schema cache for a project.
 *
 * Fire-and-forget safe — errors are logged but never thrown.
 */
export async function reloadPostgrestSchema(projectRef: string): Promise<void> {
  const functionName = `postgrest-${projectRef}`

  // 1. Fast path: NOTIFY pgrst (may work if LISTEN session survived Lambda freeze)
  try {
    const dbName = await getTenantDbName(projectRef)
    if (!dbName) {
      console.warn(`[schema-reload] Cannot resolve tenant DB for ${projectRef}, skipping NOTIFY`)
    } else {
      await withTenantClient(dbName, async (client) => {
        await client.query(`NOTIFY pgrst, 'reload schema'`)
      })
      console.debug(`[schema-reload] NOTIFY pgrst sent for ${projectRef}`)
    }
  } catch (error) {
    console.warn(
      `[schema-reload] NOTIFY failed for ${projectRef}:`,
      error instanceof Error ? error.message : error,
    )
  }

  // 2. Guaranteed fallback: force Lambda cold restart via UpdateFunctionConfiguration
  try {
    const client = getLambdaClient()
    await client.send(
      new UpdateFunctionConfigurationCommand({
        FunctionName: functionName,
        Description: `schema-reload-${Date.now()}`,
      }),
    )
    console.debug(`[schema-reload] Lambda cold restart triggered for ${functionName}`)
  } catch (error) {
    if (error instanceof ResourceNotFoundException) {
      console.warn(`[schema-reload] Lambda function not found: ${functionName}`)
      return
    }
    console.error(
      `[schema-reload] Failed to trigger cold restart for ${functionName}:`,
      error instanceof Error ? error.message : error,
    )
  }
}

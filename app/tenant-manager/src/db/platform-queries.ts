/**
 * SQL queries for supabase_platform database.
 * Manages the 4 tables: projects, jwt_keys, api_keys, postgrest_config.
 *
 * These queries were extracted from the original project-service
 * (create-pgrest-lambda.ts and server.ts) and centralised here
 * so that tenant-manager can reuse them without duplicating SQL.
 */

import { platformQuery } from './platform-connection.js'

// ---------------------------------------------------------------------------
// Result interfaces
// ---------------------------------------------------------------------------

export interface PlatformProjectRecord {
  id: string
  function_name: string
  function_url: string
  function_arn: string | null
  status: string
}

export interface ProjectConfig {
  project_id: string
  function_url: string
  jwt_secret: string
}

export interface PostgrestConfig {
  PGRST_DB_URI: string
  PGRST_DB_SCHEMAS: string
  PGRST_DB_ANON_ROLE: string
  PGRST_DB_USE_LEGACY_GUCS: string
  PGRST_JWT_SECRET: string
}

// ---------------------------------------------------------------------------
// 1. upsertPlatformProject
// ---------------------------------------------------------------------------

/**
 * Insert (or update on conflict) a project row with an empty function_url
 * and the given status. This is called at the start of Lambda creation,
 * before the function URL is known.
 *
 * ON CONFLICT (id) — projects.id is the PRIMARY KEY.
 */
export async function upsertPlatformProject(
  projectId: string,
  functionName: string,
  status = 'creating',
): Promise<void> {
  await platformQuery(
    `INSERT INTO projects (id, function_name, function_url, status)
     VALUES ($1, $2, '', $3)
     ON CONFLICT (id) DO UPDATE SET function_name = $2, status = $3`,
    [projectId, functionName, status],
  )
}

// ---------------------------------------------------------------------------
// 2. updatePlatformProject
// ---------------------------------------------------------------------------

/**
 * Set function_url, function_arn, and mark project as 'active'.
 * Called once the Lambda function is created and its URL is known.
 */
export async function updatePlatformProject(
  projectId: string,
  functionUrl: string,
  functionArn: string,
): Promise<void> {
  await platformQuery(
    `UPDATE projects SET function_url = $1, function_arn = $2, status = 'active'
     WHERE id = $3`,
    [functionUrl, functionArn, projectId],
  )
}

// ---------------------------------------------------------------------------
// 3. upsertJwtKey
// ---------------------------------------------------------------------------

/**
 * Insert (or update on conflict) a JWT signing key for a project.
 *
 * ON CONFLICT (project_id, status) — UNIQUE constraint on jwt_keys.
 * We always target status = 'current'.
 */
export async function upsertJwtKey(
  projectId: string,
  secret: string,
): Promise<void> {
  await platformQuery(
    `INSERT INTO jwt_keys (project_id, secret, algorithm, status)
     VALUES ($1, $2, 'HS256', 'current')
     ON CONFLICT (project_id, status) DO UPDATE SET secret = $2`,
    [projectId, secret],
  )
}

// ---------------------------------------------------------------------------
// 3b. getJwtSecretForProject
// ---------------------------------------------------------------------------

/**
 * Retrieve the current JWT signing secret for a project.
 * Used by the admin endpoint so GoTrue can sign JWTs with the per-project secret.
 */
export async function getJwtSecretForProject(projectId: string): Promise<string | null> {
  const result = await platformQuery<{ secret: string }>(
    `SELECT secret FROM jwt_keys WHERE project_id = $1 AND status = 'current' LIMIT 1`,
    [projectId],
  )
  return result.rows[0]?.secret ?? null
}

// ---------------------------------------------------------------------------
// 4. upsertApiKey
// ---------------------------------------------------------------------------

/**
 * Insert (or update on conflict) an API key for a project.
 *
 * ON CONFLICT (project_id, role) — UNIQUE constraint on api_keys.
 */
export async function upsertApiKey(
  projectId: string,
  name: string,
  keyType: string,
  role: string,
  keyValue: string,
  hashedSecret: string,
): Promise<void> {
  await platformQuery(
    `INSERT INTO api_keys (project_id, name, key_type, role, key_value, hashed_secret)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (project_id, role) DO UPDATE SET key_value = $5, hashed_secret = $6`,
    [projectId, name, keyType, role, keyValue, hashedSecret],
  )
}

// ---------------------------------------------------------------------------
// 4b. getApiKeysByProjectId
// ---------------------------------------------------------------------------

/**
 * Retrieve all API keys for a project from the platform DB.
 * Returns the full opaque key (key_value) which is registered in Kong key-auth.
 */
export async function getApiKeysByProjectId(
  projectId: string,
): Promise<Array<{ name: string; key_type: string; role: string; key_value: string }>> {
  const result = await platformQuery(
    `SELECT name, key_type, role, key_value FROM api_keys WHERE project_id = $1`,
    [projectId],
  )
  return result.rows as Array<{ name: string; key_type: string; role: string; key_value: string }>
}

// ---------------------------------------------------------------------------
// 5. upsertPostgrestConfig
// ---------------------------------------------------------------------------

/**
 * Insert (or update on conflict) the PostgREST connection config for a project.
 *
 * ON CONFLICT (project_id) — postgrest_config.project_id is the PRIMARY KEY.
 */
export async function upsertPostgrestConfig(
  projectId: string,
  dbUri: string,
): Promise<void> {
  await platformQuery(
    `INSERT INTO postgrest_config (project_id, db_uri, db_schemas, db_anon_role, db_use_legacy_gucs)
     VALUES ($1, $2, 'public', 'anon', 'false')
     ON CONFLICT (project_id) DO UPDATE SET db_uri = $2`,
    [projectId, dbUri],
  )
}

// ---------------------------------------------------------------------------
// 6. getProjectConfig
// ---------------------------------------------------------------------------

/**
 * Retrieve the project config needed by the Kong dynamic-lambda-router plugin.
 * JOINs projects + jwt_keys so the caller gets function_url and jwt_secret
 * in a single round-trip.
 *
 * Returns null when the project does not exist or is not active.
 */
export async function getProjectConfig(
  projectId: string,
): Promise<ProjectConfig | null> {
  const result = await platformQuery<{
    id: string
    function_url: string
    jwt_secret: string
  }>(
    `SELECT p.id, p.function_url, j.secret AS jwt_secret
     FROM projects p
     JOIN jwt_keys j ON j.project_id = p.id AND j.status = 'current'
     WHERE p.id = $1 AND p.status = 'active'
     LIMIT 1`,
    [projectId],
  )

  const row = result.rows[0]
  if (!row) return null

  return {
    project_id: row.id,
    function_url: row.function_url,
    jwt_secret: row.jwt_secret,
  }
}

// ---------------------------------------------------------------------------
// 7. getPostgrestConfig
// ---------------------------------------------------------------------------

/**
 * Retrieve the PostgREST bootstrap config for a Lambda function.
 * JOINs postgrest_config + jwt_keys to provide all env vars PostgREST needs.
 *
 * Returns null when no config exists for the given project.
 */
export async function getPostgrestConfig(
  projectId: string,
): Promise<PostgrestConfig | null> {
  const result = await platformQuery<{
    db_uri: string
    db_schemas: string
    db_anon_role: string
    db_use_legacy_gucs: string
    jwt_secret: string
  }>(
    `SELECT pc.db_uri, pc.db_schemas, pc.db_anon_role, pc.db_use_legacy_gucs,
            j.secret AS jwt_secret
     FROM postgrest_config pc
     JOIN jwt_keys j ON j.project_id = pc.project_id AND j.status = 'current'
     WHERE pc.project_id = $1
     LIMIT 1`,
    [projectId],
  )

  const row = result.rows[0]
  if (!row) return null

  return {
    PGRST_DB_URI: row.db_uri,
    PGRST_DB_SCHEMAS: row.db_schemas,
    PGRST_DB_ANON_ROLE: row.db_anon_role,
    PGRST_DB_USE_LEGACY_GUCS: row.db_use_legacy_gucs,
    PGRST_JWT_SECRET: row.jwt_secret,
  }
}

// ---------------------------------------------------------------------------
// 8. deletePlatformProjectData
// ---------------------------------------------------------------------------

/**
 * Delete all data for a project from the 4 platform tables.
 *
 * Order matters because of foreign-key constraints:
 *   api_keys, jwt_keys, postgrest_config  (all reference projects.id)
 *   projects                              (parent row, deleted last)
 */
export async function deletePlatformProjectData(
  projectId: string,
): Promise<void> {
  // Delete child rows first (FK references projects.id)
  await platformQuery('DELETE FROM api_keys WHERE project_id = $1', [projectId])
  await platformQuery('DELETE FROM jwt_keys WHERE project_id = $1', [projectId])
  await platformQuery('DELETE FROM postgrest_config WHERE project_id = $1', [projectId])

  // Delete parent row last
  await platformQuery('DELETE FROM projects WHERE id = $1', [projectId])
}

/**
 * Project lifecycle management service
 * Handles project provisioning and deprovisioning with rollback support
 * Uses Kysely repository + direct pg connections (no pg-meta/dblink)
 */

import crypto from 'crypto'
import { getEnv } from '../../config/index.js'
import {
  findProjectByRef,
  findProjects,
  countProjects,
  insertProject,
  updateProjectByRef,
  deleteProjectByRef,
  updateProjectStatus,
  type ListProjectsOptions,
} from '../../db/repositories/project.repository.js'
import { generateProjectRef, generateDbName, generateJwtSecret } from '../../common/crypto/key-generator.js'
import { generateOpaqueKey, generateApiKeyJwt } from '../../common/crypto/api-key-generator.js'
import {
  createProjectDatabase,
  initializeProjectDatabase,
  deleteProjectDatabase,
} from '../provisioning/provisioner.service.js'
import { selectInstance } from '../balancer/rds-balancer.service.js'
import {
  findRdsInstanceById,
  updateDatabaseCount,
} from '../../db/repositories/rds-instance.repository.js'
import { registerSupavisorTenant, deleteSupavisorTenant, getSupavisorTenant } from '../../integrations/supavisor/supavisor.client.js'
import { registerRealtimeTenant, deleteRealtimeTenant, getRealtimeTenant } from '../../integrations/realtime/realtime.client.js'
import { registerAuthTenant, deleteAuthTenant, isAuthMultiTenantEnabled, getAuthTenant } from '../../integrations/auth/auth.client.js'
import { getSecretsStore } from '../../integrations/secrets-manager/index.js'
import type {
  CreateProjectInput,
  CreationState,
  ProvisioningResult,
  TenantConfig,
  ProjectHealthResult,
  ApiKeyCreatedResponse,
} from '../../types/index.js'
import type { ProjectSecretDocument } from '../../types/project-secret.js'
import type { JwtKey } from '../../types/jwt-key.js'
import type { ApiKey } from '../../types/api-key.js'
import type { Project } from '../../db/types.js'
import { withTenantClient } from '../../db/connection.js'
import {
  resolveInstanceCredentials,
  withInstanceTenantClient,
  type InstanceConnectionInfo,
} from '../../db/instance-connection.js'
import { createPostgrestLambda, deletePostgrestLambda, isLambdaCreationEnabled } from '../../integrations/lambda/lambda.service.js'
import { registerProjectConsumers, deleteProjectConsumers } from '../../integrations/kong/kong-admin.client.js'
import { cleanupProjectEdgeFunctions } from '../../integrations/studio/edge-functions.client.js'
import {
  upsertPlatformProject,
  updatePlatformProject,
  upsertJwtKey,
  upsertApiKey,
  upsertPostgrestConfig,
  deletePlatformProjectData,
} from '../../db/platform-queries.js'

/**
 * Get project record from the database
 */
export async function getProjectByRef(ref: string): Promise<Project | null> {
  return findProjectByRef(ref)
}

/**
 * List all projects
 */
export async function listProjects(params: ListProjectsOptions = {}): Promise<Project[]> {
  return findProjects(params)
}

/**
 * Get total count of projects
 */
export async function getProjectsCount(params: Omit<ListProjectsOptions, 'page' | 'limit' | 'sort'> = {}): Promise<number> {
  return countProjects(params)
}

/**
 * Rollback a partially created project
 */
async function rollback(
  ref: string,
  dbName: string,
  state: CreationState,
  errors: string[],
  conn?: InstanceConnectionInfo
): Promise<void> {
  console.debug(`Rolling back project ${ref}...`)

  if (state.kongConsumers) {
    try {
      await deleteProjectConsumers(ref)
    } catch (e) {
      errors.push(`Failed to delete Kong consumers: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  if (state.lambdaCreated) {
    try {
      await deletePostgrestLambda(ref)
    } catch (e) {
      errors.push(`Failed to delete Lambda: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  if (state.platformDbWritten) {
    try {
      await deletePlatformProjectData(ref)
    } catch (e) {
      errors.push(`Failed to delete platform DB data: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  if (state.projectRecord) {
    const deleted = await deleteProjectByRef(ref)
    if (!deleted) {
      errors.push('Failed to delete project record during rollback')
    }
  }

  if (state.supavisorTenant) {
    const result = await deleteSupavisorTenant(ref)
    if (!result.success) {
      errors.push(`Failed to delete Supavisor tenant: ${result.error}`)
    }
  }

  if (state.realtimeTenant) {
    const result = await deleteRealtimeTenant(ref)
    if (!result.success) {
      errors.push(`Failed to delete Realtime tenant: ${result.error}`)
    }
  }

  if (state.authTenant) {
    const result = await deleteAuthTenant(ref)
    if (!result.success) {
      errors.push(`Failed to delete Auth tenant: ${result.error}`)
    }
  }

  if (state.dbCreated) {
    const result = await deleteProjectDatabase(dbName, conn)
    if (!result.success) {
      errors.push(`Failed to delete database: ${result.error}`)
    }
  }

  // Clean up Secrets Manager
  try {
    const secretsStore = getSecretsStore()
    await secretsStore.deleteProjectSecret(ref)
  } catch (error) {
    errors.push(`Failed to delete project secret: ${error instanceof Error ? error.message : String(error)}`)
  }

  console.debug(`Rollback completed for project ${ref}`)
}

/**
 * Provision a new project with full lifecycle management
 */
export async function provisionProject(input: CreateProjectInput): Promise<ProvisioningResult> {
  const ref = input.ref || generateProjectRef()
  const dbName = generateDbName(ref)
  const jwtSecret = generateJwtSecret()
  const errors: string[] = []

  const state: CreationState = {
    dbCreated: false,
    dbInitialized: false,
    authTenant: false,
    storageTenant: false,
    realtimeTenant: false,
    supavisorTenant: false,
    postgrestStarted: false,
    kongRoutes: false,
    projectRecord: false,
    platformDbWritten: false,
    lambdaCreated: false,
    kongConsumers: false,
  }

  let selectedInstanceId: number | null = null
  let conn: InstanceConnectionInfo | undefined

  try {
    console.debug(`Provisioning project ${ref}...`)

    // 0. Select RDS instance via balancer
    let dbHost: string
    let dbPort: number
    let instanceId: number
    let resolvedInstance: Awaited<ReturnType<typeof findRdsInstanceById>>

    if (input.db_instance_id) {
      // User specified an instance ID directly - validate it
      const instance = await findRdsInstanceById(input.db_instance_id)
      if (!instance || instance.status !== 'active' || instance.current_databases >= instance.max_databases) {
        throw new Error(
          instance
            ? `Specified RDS instance ${input.db_instance_id} is not available (status: ${instance.status}, databases: ${instance.current_databases}/${instance.max_databases})`
            : `RDS instance not found: ${input.db_instance_id}`
        )
      }
      instanceId = instance.id
      dbHost = instance.host
      dbPort = instance.port
      resolvedInstance = instance
    } else {
      // Auto-select via balancer strategy
      const result = await selectInstance({
        projectRef: ref,
        organizationId: input.organization_id || 1,
        region: input.region,
        instanceIdentifier: input.instance_identifier,
        strategyOverride: input.strategy,
      })
      const instance = await findRdsInstanceById(result.instance_id)
      if (!instance) {
        throw new Error('Selected instance no longer exists')
      }
      instanceId = instance.id
      dbHost = instance.host
      dbPort = instance.port
      resolvedInstance = instance
      console.debug(`Auto-selected instance ${result.instance_identifier}: ${result.reason}`)
    }

    selectedInstanceId = instanceId

    // Resolve instance credentials for DDL operations on the target RDS instance
    conn = await resolveInstanceCredentials(resolvedInstance!)

    // 1. Create project record first (for tracking)
    const project = await insertProject({
      ref,
      name: input.name,
      db_name: dbName,
      db_host: dbHost,
      db_port: dbPort,
      db_instance_id: instanceId,
      status: 'COMING_UP',
      creation_status: 'creating_database',
      organization_id: input.organization_id || 1,
    })

    state.projectRecord = true

    // Increment database count on the selected instance
    await updateDatabaseCount(instanceId, 1)

    console.debug(`Created project record for ${ref} on instance ${instanceId}`)

    // 2. Create database on the target RDS instance
    await updateProjectStatus(ref, 'COMING_UP', 'creating_database')
    const createResult = await createProjectDatabase(dbName, conn)
    if (!createResult.success) {
      throw new Error(`Failed to create database: ${createResult.error}`)
    }
    state.dbCreated = true
    console.debug(`Created database ${dbName}`)

    // 3. Initialize database on the target RDS instance
    await updateProjectStatus(ref, 'COMING_UP', 'initializing')
    const initResult = await initializeProjectDatabase(dbName, conn)
    if (!initResult.success) {
      throw new Error(`Failed to initialize database: ${initResult.error}`)
    }
    state.dbInitialized = true
    console.debug(`Initialized database ${dbName}`)

    // 4. Generate API keys
    await updateProjectStatus(ref, 'COMING_UP', 'registering_services')

    const jwtKeyId = crypto.randomUUID()
    const jwtKey: JwtKey = {
      id: jwtKeyId,
      secret: jwtSecret,
      status: 'current',
      algorithm: 'HS256',
      created_at: new Date().toISOString(),
      rotated_at: null,
    }

    const anonOpaqueResult = generateOpaqueKey('publishable')
    const anonApiKeyId = crypto.randomUUID()
    const anonJwt = generateApiKeyJwt({
      projectRef: ref,
      role: 'anon',
      jwtSecret,
      keyId: jwtKeyId,
      apiKeyId: anonApiKeyId,
    })

    const serviceOpaqueResult = generateOpaqueKey('secret')
    const serviceApiKeyId = crypto.randomUUID()
    const serviceJwt = generateApiKeyJwt({
      projectRef: ref,
      role: 'service_role',
      jwtSecret,
      keyId: jwtKeyId,
      apiKeyId: serviceApiKeyId,
    })

    // 5. Register with services (using new SM-based JWTs)
    const tenantConfig: TenantConfig = {
      projectRef: ref,
      dbName,
      dbHost: project.db_host,
      dbPort: project.db_port,
      dbPassword: conn!.password,
      jwtSecret,
      anonKey: anonJwt,
      serviceRoleKey: serviceJwt,
    }

    // Register with Supavisor
    const supavisorResult = await registerSupavisorTenant(tenantConfig)
    if (!supavisorResult.success) {
      console.warn(`Warning: Failed to register Supavisor tenant: ${supavisorResult.error}`)
    } else {
      state.supavisorTenant = true
      console.debug(`Registered Supavisor tenant for ${ref}`)
    }

    // Register with Realtime
    const realtimeResult = await registerRealtimeTenant(tenantConfig)
    if (!realtimeResult.success) {
      console.warn(`Warning: Failed to register Realtime tenant: ${realtimeResult.error}`)
    } else {
      state.realtimeTenant = true
      console.debug(`Registered Realtime tenant for ${ref}`)
    }

    // Register with Auth (if multi-tenant mode is enabled)
    if (isAuthMultiTenantEnabled()) {
      const authResult = await registerAuthTenant(tenantConfig)
      if (!authResult.success) {
        console.warn(`Warning: Failed to register Auth tenant: ${authResult.error}`)
      } else {
        state.authTenant = true
        console.debug(`Registered Auth tenant for ${ref}`)
      }
    }

    // 6. Store project secret in AWS Secrets Manager
    const now = new Date().toISOString()
    const anonApiKey: ApiKey = {
      id: anonApiKeyId,
      project_ref: ref,
      name: 'Default Anon Key',
      type: 'publishable',
      role: 'anon',
      prefix: anonOpaqueResult.prefix,
      hashed_secret: anonOpaqueResult.hashedSecret,
      jwt: anonJwt,
      jwt_key_id: jwtKeyId,
      status: 'active',
      description: 'Auto-generated default publishable key',
      created_at: now,
      updated_at: now,
      revoked_at: null,
    }

    const serviceApiKey: ApiKey = {
      id: serviceApiKeyId,
      project_ref: ref,
      name: 'Default Service Role Key',
      type: 'secret',
      role: 'service_role',
      prefix: serviceOpaqueResult.prefix,
      hashed_secret: serviceOpaqueResult.hashedSecret,
      jwt: serviceJwt,
      jwt_key_id: jwtKeyId,
      status: 'active',
      description: 'Auto-generated default service role key',
      created_at: now,
      updated_at: now,
      revoked_at: null,
    }

    const dbUri = `postgresql://${encodeURIComponent(conn.user)}:${encodeURIComponent(conn.password)}@${conn.host}:${conn.port}/${dbName}`
    const secretDoc: ProjectSecretDocument = {
      version: 1,
      project_ref: ref,
      database: {
        DB_URI: dbUri,
        DB_SCHEMAS: 'public',
        DB_ANON_ROLE: 'postgres',
        DB_USE_LEGACY_GUCS: 'false',
      },
      jwt_keys: [jwtKey],
      api_keys: [anonApiKey, serviceApiKey],
    }

    const secretsStore = getSecretsStore()
    await secretsStore.putProjectSecret(ref, secretDoc)
    console.debug(`Stored project secret in AWS Secrets Manager for ${ref}`)

    const apiKeysCreated: ApiKeyCreatedResponse[] = [
      {
        id: anonApiKeyId,
        name: 'Default Anon Key',
        type: 'publishable',
        role: 'anon',
        prefix: anonOpaqueResult.prefix,
        opaque_key: anonOpaqueResult.opaqueKey,
        jwt: anonJwt,
        description: 'Auto-generated default publishable key',
        created_at: now,
      },
      {
        id: serviceApiKeyId,
        name: 'Default Service Role Key',
        type: 'secret',
        role: 'service_role',
        prefix: serviceOpaqueResult.prefix,
        opaque_key: serviceOpaqueResult.opaqueKey,
        jwt: serviceJwt,
        description: 'Auto-generated default service role key',
        created_at: now,
      },
    ]

    // 6.5 Write to supabase_platform DB (for runtime config queries)
    if (isLambdaCreationEnabled()) {
      const platformFunctionName = `postgrest-${ref}`
      await upsertPlatformProject(ref, platformFunctionName, 'creating')
      await upsertJwtKey(ref, jwtSecret)
      await upsertApiKey(ref, 'Default Anon Key', 'publishable', 'anon',
        anonOpaqueResult.opaqueKey, anonOpaqueResult.hashedSecret)
      await upsertApiKey(ref, 'Default Service Role Key', 'secret', 'service_role',
        serviceOpaqueResult.opaqueKey, serviceOpaqueResult.hashedSecret)
      await upsertPostgrestConfig(ref, dbUri)
      state.platformDbWritten = true
      console.debug(`Wrote platform DB records for ${ref}`)

      // 6.6 Create PostgREST Lambda + Function URL
      await updateProjectStatus(ref, 'COMING_UP', 'registering_services')
      const lambdaResult = await createPostgrestLambda(ref)
      state.lambdaCreated = true
      console.debug(`Created Lambda ${lambdaResult.functionName}: ${lambdaResult.functionUrl}`)

      // 6.7 Update platform DB with Lambda details
      await updatePlatformProject(ref, lambdaResult.functionUrl, lambdaResult.functionArn)

      // 6.8 Register Kong consumers
      try {
        await registerProjectConsumers(ref, anonOpaqueResult.opaqueKey, serviceOpaqueResult.opaqueKey)
        state.kongConsumers = true
        console.debug(`Registered Kong consumers for ${ref}`)
      } catch (error) {
        console.warn(`Warning: Kong consumer registration failed (non-fatal): ${error instanceof Error ? error.message : error}`)
      }
    }

    // 7. Mark as complete
    await updateProjectStatus(ref, 'ACTIVE_HEALTHY', 'completed')
    console.debug(`Project ${ref} provisioned successfully`)

    // Get the final project record
    const finalProject = await findProjectByRef(ref)

    return {
      success: true,
      project: finalProject || project,
      rollbackPerformed: false,
      api_keys: apiKeysCreated,
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error during provisioning'
    console.error(`Error provisioning project ${ref}: ${errorMessage}`)

    // Decrement database count if we incremented it
    if (selectedInstanceId && state.projectRecord) {
      try {
        await updateDatabaseCount(selectedInstanceId, -1)
      } catch (countErr) {
        errors.push(`Failed to decrement instance counter: ${countErr instanceof Error ? countErr.message : String(countErr)}`)
      }
    }

    await rollback(ref, dbName, state, errors, conn)

    return {
      success: false,
      error: errorMessage + (errors.length > 0 ? `. Rollback errors: ${errors.join('; ')}` : ''),
      rollbackPerformed: true,
    }
  }
}

/**
 * Deprovision a project and clean up all resources
 */
export async function deprovisionProject(ref: string): Promise<ProvisioningResult> {
  if (ref === 'default') {
    return { success: false, error: 'Cannot delete the default project' }
  }

  const errors: string[] = []

  try {
    console.debug(`Deprovisioning project ${ref}...`)

    const project = await findProjectByRef(ref)
    if (!project) {
      return { success: false, error: `Project not found: ${ref}` }
    }

    await updateProjectStatus(ref, 'GOING_DOWN', 'deleting')

    // 1. Delete from Realtime
    const realtimeResult = await deleteRealtimeTenant(ref)
    if (!realtimeResult.success) {
      console.warn(`Warning: Failed to delete Realtime tenant: ${realtimeResult.error}`)
      errors.push(`Realtime: ${realtimeResult.error}`)
    } else {
      console.debug(`Deleted Realtime tenant for ${ref}`)
    }

    // 2. Delete from Auth
    if (isAuthMultiTenantEnabled()) {
      const authResult = await deleteAuthTenant(ref)
      if (!authResult.success) {
        console.warn(`Warning: Failed to delete Auth tenant: ${authResult.error}`)
        errors.push(`Auth: ${authResult.error}`)
      } else {
        console.debug(`Deleted Auth tenant for ${ref}`)
      }
    }

    // 3. Delete from Supavisor
    const supavisorResult = await deleteSupavisorTenant(ref)
    if (!supavisorResult.success) {
      console.warn(`Warning: Failed to delete Supavisor tenant: ${supavisorResult.error}`)
      errors.push(`Supavisor: ${supavisorResult.error}`)
    } else {
      console.debug(`Deleted Supavisor tenant for ${ref}`)
    }

    // 3.5 Delete Edge Functions (before deleting database)
    try {
      const functionsResult = await cleanupProjectEdgeFunctions(ref)
      if (functionsResult.success) {
        console.debug(`Deleted ${functionsResult.deletedCount || 0} Edge Functions for ${ref}`)
      } else {
        console.warn(`Warning: Failed to cleanup Edge Functions: ${functionsResult.error}`)
        errors.push(`EdgeFunctions: ${functionsResult.error}`)
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      console.warn(`Warning: Failed to cleanup Edge Functions: ${msg}`)
      // Non-critical - continue with deletion
    }

    // 4. Delete database from the correct RDS instance
    let deprovisionConn: InstanceConnectionInfo | undefined
    if (project.db_instance_id) {
      const instance = await findRdsInstanceById(project.db_instance_id)
      if (instance) {
        try {
          deprovisionConn = await resolveInstanceCredentials(instance)
        } catch (e) {
          console.warn(`Failed to resolve credentials for instance ${project.db_instance_id}, falling back to default host: ${e instanceof Error ? e.message : e}`)
        }
      }
    }
    const dbResult = await deleteProjectDatabase(project.db_name, deprovisionConn)
    if (!dbResult.success) {
      console.error(`Failed to delete database: ${dbResult.error}`)
      errors.push(`Database: ${dbResult.error}`)
    } else {
      console.debug(`Deleted database ${project.db_name}`)
    }

    // 4.5. Delete project secret from AWS Secrets Manager
    try {
      const secretsStore = getSecretsStore()
      await secretsStore.deleteProjectSecret(ref)
      console.debug(`Deleted project secret for ${ref}`)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      console.warn(`Warning: Failed to delete project secret: ${msg}`)
      errors.push(`SecretsManager: ${msg}`)
    }

    // 4.6 Delete Kong consumers
    try {
      await deleteProjectConsumers(ref)
      console.debug(`Deleted Kong consumers for ${ref}`)
    } catch (error) {
      console.warn(`Warning: Failed to delete Kong consumers: ${error instanceof Error ? error.message : error}`)
    }

    // 4.7 Delete Lambda function
    try {
      await deletePostgrestLambda(ref)
      console.debug(`Deleted Lambda for ${ref}`)
    } catch (error) {
      console.warn(`Warning: Failed to delete Lambda: ${error instanceof Error ? error.message : error}`)
    }

    // 4.8 Delete platform DB data
    try {
      await deletePlatformProjectData(ref)
      console.debug(`Deleted platform DB data for ${ref}`)
    } catch (error) {
      console.warn(`Warning: Failed to delete platform DB data: ${error instanceof Error ? error.message : error}`)
    }

    // 5. Decrement database count on the instance
    if (project.db_instance_id) {
      try {
        await updateDatabaseCount(project.db_instance_id, -1)
      } catch (countErr) {
        console.warn(`Warning: Failed to decrement instance counter: ${countErr instanceof Error ? countErr.message : String(countErr)}`)
        errors.push(`Counter: ${countErr instanceof Error ? countErr.message : String(countErr)}`)
      }
    }

    // 6. Delete project record
    const recordDeleted = await deleteProjectByRef(ref)
    if (!recordDeleted) {
      return {
        success: false,
        error: 'Failed to delete project record' + (errors.length > 0 ? `. Previous errors: ${errors.join('; ')}` : ''),
      }
    }

    console.debug(`Project ${ref} deprovisioned successfully`)
    return { success: true, rollbackPerformed: false }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error during deprovisioning'
    console.error(`Error deprovisioning project ${ref}: ${errorMessage}`)
    return {
      success: false,
      error: errorMessage + (errors.length > 0 ? `. Previous errors: ${errors.join('; ')}` : ''),
    }
  }
}

/**
 * Pause a project
 */
export async function pauseProject(ref: string): Promise<ProvisioningResult> {
  if (ref === 'default') {
    return { success: false, error: 'Cannot pause the default project' }
  }

  const project = await findProjectByRef(ref)
  if (!project) {
    return { success: false, error: `Project not found: ${ref}` }
  }

  if (project.status === 'PAUSED') {
    return { success: true, project }
  }

  await updateProjectStatus(ref, 'PAUSING', 'pausing')

  await deleteSupavisorTenant(ref)
  await deleteRealtimeTenant(ref)
  if (isAuthMultiTenantEnabled()) {
    await deleteAuthTenant(ref)
  }

  await updateProjectStatus(ref, 'PAUSED', 'paused')

  const updatedProject = await findProjectByRef(ref)
  return { success: true, project: updatedProject || project }
}

/**
 * Restore a paused project
 */
export async function restoreProject(ref: string): Promise<ProvisioningResult> {
  const project = await findProjectByRef(ref)
  if (!project) {
    return { success: false, error: `Project not found: ${ref}` }
  }

  if (project.status !== 'PAUSED') {
    return { success: false, error: `Project is not paused: ${ref}` }
  }

  const env = getEnv()
  await updateProjectStatus(ref, 'RESTORING', 'restoring')

  // Read keys from Secrets Manager
  const secretsStore = getSecretsStore()
  const secretDoc = await secretsStore.getProjectSecret(ref)
  if (!secretDoc) {
    return { success: false, error: 'Project secret not found' }
  }

  const currentJwtKey = secretDoc.jwt_keys.find((k) => k.status === 'current')
  if (!currentJwtKey?.secret) {
    return { success: false, error: 'Project secret document is missing a current JWT key' }
  }

  const anonApiKey = secretDoc.api_keys.find((k) => k.role === 'anon' && k.status === 'active')
  const serviceApiKey = secretDoc.api_keys.find((k) => k.role === 'service_role' && k.status === 'active')
  if (!anonApiKey?.jwt || !serviceApiKey?.jwt) {
    return { success: false, error: 'Project secret document is missing active API keys' }
  }

  const jwtSecret = currentJwtKey.secret
  const anonKey = anonApiKey.jwt
  const serviceRoleKey = serviceApiKey.jwt

  // Resolve instance-specific password, fall back to global env
  let dbPassword = env.POSTGRES_PASSWORD
  if (project.db_instance_id) {
    const instance = await findRdsInstanceById(project.db_instance_id)
    if (instance) {
      try {
        const restoreConn = await resolveInstanceCredentials(instance)
        dbPassword = restoreConn.password
      } catch { /* fall back to env */ }
    }
  }

  const tenantConfig: TenantConfig = {
    projectRef: ref,
    dbName: project.db_name,
    dbHost: project.db_host,
    dbPort: project.db_port,
    dbPassword,
    jwtSecret,
    anonKey,
    serviceRoleKey,
  }

  await registerSupavisorTenant(tenantConfig)
  await registerRealtimeTenant(tenantConfig)
  if (isAuthMultiTenantEnabled()) {
    await registerAuthTenant(tenantConfig)
  }

  await updateProjectStatus(ref, 'ACTIVE_HEALTHY', 'completed')

  const updatedProject = await findProjectByRef(ref)
  return { success: true, project: updatedProject || project }
}

/**
 * Update a project
 */
export async function updateProject(
  ref: string,
  updates: { name?: string }
): Promise<ProvisioningResult> {
  const project = await findProjectByRef(ref)
  if (!project) {
    return { success: false, error: `Project not found: ${ref}` }
  }

  if (updates.name) {
    const updated = await updateProjectByRef(ref, { name: updates.name })
    if (!updated) {
      return { success: false, error: 'Failed to update project' }
    }
    return { success: true, project: updated }
  }

  return { success: true, project }
}

/**
 * Get database credentials for a project
 */
export async function getProjectDatabaseCredentials(ref: string) {
  const project = await findProjectByRef(ref)
  if (!project) {
    return { success: false as const, error: 'not_found', message: `Project not found: ${ref}` }
  }

  if (!project.db_instance_id) {
    return { success: false as const, error: 'no_instance', message: 'Project has no associated database instance' }
  }

  const instance = await findRdsInstanceById(project.db_instance_id)
  if (!instance) {
    return { success: false as const, error: 'instance_not_found', message: 'Associated RDS instance not found' }
  }

  let conn: InstanceConnectionInfo
  try {
    conn = await resolveInstanceCredentials(instance)
  } catch (e) {
    return { success: false as const, error: 'credentials_failed', message: `Failed to resolve database credentials: ${e instanceof Error ? e.message : String(e)}` }
  }

  return {
    success: true as const,
    data: {
      project_ref: ref,
      db_name: project.db_name,
      host: conn.host,
      port: conn.port,
      user: conn.user,
      password: conn.password,
    },
  }
}

/**
 * Check the health of a project's services
 */
export async function checkProjectHealth(ref: string): Promise<ProjectHealthResult> {
  const errors: string[] = []
  let database = false
  let supavisor = false
  let realtime = false
  let auth = false

  const project = await findProjectByRef(ref)
  if (!project) {
    return {
      healthy: false,
      database: false,
      supavisor: false,
      realtime: false,
      auth: false,
      errors: ['Project not found'],
    }
  }

  // Check database (direct connection to the correct RDS instance)
  try {
    let healthConn: InstanceConnectionInfo | undefined
    if (project.db_instance_id) {
      const instance = await findRdsInstanceById(project.db_instance_id)
      if (instance) {
        try {
          healthConn = await resolveInstanceCredentials(instance)
        } catch {
          // Fall back to default host
        }
      }
    }
    if (healthConn) {
      await withInstanceTenantClient(healthConn, project.db_name, async (client) => {
        await client.query('SELECT 1')
      })
    } else {
      await withTenantClient(project.db_name, async (client) => {
        await client.query('SELECT 1')
      })
    }
    database = true
  } catch (error) {
    errors.push(`Database: ${error instanceof Error ? error.message : 'Unknown error'}`)
  }

  // Check Supavisor
  try {
    const result = await getSupavisorTenant(ref)
    supavisor = result.success
    if (!result.success && result.error) {
      errors.push(`Supavisor: ${result.error}`)
    }
  } catch (error) {
    errors.push(`Supavisor: ${error instanceof Error ? error.message : 'Unknown error'}`)
  }

  // Check Realtime
  try {
    const result = await getRealtimeTenant(ref)
    realtime = result.success
    if (!result.success && result.error) {
      errors.push(`Realtime: ${result.error}`)
    }
  } catch (error) {
    errors.push(`Realtime: ${error instanceof Error ? error.message : 'Unknown error'}`)
  }

  // Check Auth
  if (isAuthMultiTenantEnabled()) {
    try {
      const result = await getAuthTenant(ref)
      auth = result.success
      if (!result.success && result.error) {
        errors.push(`Auth: ${result.error}`)
      }
    } catch (error) {
      errors.push(`Auth: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  } else {
    auth = true
  }

  return {
    healthy: database && supavisor && realtime && auth,
    database,
    supavisor,
    realtime,
    auth,
    errors,
  }
}

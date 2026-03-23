/**
 * PostgreSQL-based Project Store
 * 
 * Stores project metadata in PostgreSQL instead of JSON files
 * This provides better reliability, scalability, and multi-instance support
 */

import { executeQuery } from './query'
import { WrappedResult } from './types'
import { getCredentialFallbackManager, ProjectCredentials } from './credential-fallback-manager'

/**
 * Project metadata structure
 */
export interface ProjectMetadata {
  id: number
  ref: string
  name: string
  database_name: string
  database_user: string | null // Project-specific database user (nullable for legacy projects)
  database_password_hash: string | null // Hashed password for storage (nullable for legacy projects)
  organization_id: number
  owner_user_id?: string
  status: ProjectStatus
  region: string
  connection_string: string
  inserted_at: string
  updated_at: string
}

/**
 * Enhanced project metadata with credential status information
 */
export interface EnhancedProjectMetadata extends ProjectMetadata {
  credential_status: 'complete' | 'missing_user' | 'missing_password' | 'missing_both'
  last_credential_check: string
  uses_fallback_credentials: boolean
}

/**
 * Project status types
 */
export type ProjectStatus =
  | 'ACTIVE_HEALTHY'
  | 'INACTIVE'
  | 'COMING_UP'
  | 'UNKNOWN'
  | 'REMOVED'

/**
 * Error codes for project store operations
 */
export enum ProjectStoreErrorCode {
  PROJECT_NOT_FOUND = 'PROJECT_NOT_FOUND',
  PROJECT_ALREADY_EXISTS = 'PROJECT_ALREADY_EXISTS',
  INVALID_PROJECT_DATA = 'INVALID_PROJECT_DATA',
  DATABASE_ERROR = 'DATABASE_ERROR',
  UNKNOWN_ERROR = 'UNKNOWN_ERROR',
}

/**
 * Custom error class for project store operations
 */
export class ProjectStoreError extends Error {
  constructor(
    public code: ProjectStoreErrorCode,
    message: string,
    public details?: any
  ) {
    super(message)
    this.name = 'ProjectStoreError'
  }
}

/**
 * Calculates credential status for a project
 */
function calculateCredentialStatus(
  databaseUser: string | null | undefined,
  databasePasswordHash: string | null | undefined
): 'complete' | 'missing_user' | 'missing_password' | 'missing_both' {
  const hasUser = databaseUser !== null && databaseUser !== undefined && databaseUser.trim() !== ''
  const hasPassword = databasePasswordHash !== null && databasePasswordHash !== undefined && databasePasswordHash.trim() !== ''

  if (hasUser && hasPassword) {
    return 'complete'
  } else if (!hasUser && !hasPassword) {
    return 'missing_both'
  } else if (!hasUser) {
    return 'missing_user'
  } else {
    return 'missing_password'
  }
}

/**
 * Enhances project metadata with credential status information
 */
function enhanceProjectWithCredentialStatus(project: ProjectMetadata): EnhancedProjectMetadata {
  const credentialStatus = calculateCredentialStatus(project.database_user, project.database_password_hash)
  const usesFallback = credentialStatus !== 'complete'

  return {
    ...project,
    credential_status: credentialStatus,
    last_credential_check: new Date().toISOString(),
    uses_fallback_credentials: usesFallback
  }
}

/**
 * Gets effective credentials for a project, preferring project-specific over fallback
 */
async function getEffectiveCredentials(
  project: ProjectMetadata,
  readOnly: boolean = false
): Promise<{ user: string; password: string; usedFallback: boolean; fallbackReason?: string }> {
  const fallbackManager = getCredentialFallbackManager()
  const projectCredentials = fallbackManager.getProjectCredentials(
    project.ref,
    project.database_user,
    project.database_password_hash
  )

  // Prefer project-specific credentials if complete
  if (projectCredentials.isComplete && projectCredentials.user && projectCredentials.passwordHash) {
    return {
      user: projectCredentials.user,
      password: projectCredentials.passwordHash, // Note: This should be decrypted in real implementation
      usedFallback: false
    }
  }

  // Fall back to system credentials
  const fallbackCredentials = await fallbackManager.getFallbackCredentials(readOnly)
  
  // Determine fallback reason
  let fallbackReason = 'missing_both'
  if (projectCredentials.user && !projectCredentials.passwordHash) {
    fallbackReason = 'missing_password'
  } else if (!projectCredentials.user && projectCredentials.passwordHash) {
    fallbackReason = 'missing_user'
  }

  // Log fallback usage
  fallbackManager.logFallbackUsage(project.ref, fallbackReason, fallbackReason as any)

  return {
    user: fallbackCredentials.user,
    password: fallbackCredentials.password,
    usedFallback: true,
    fallbackReason
  }
}

/**
 * Validates project metadata
 */
function validateProjectMetadata(project: Partial<ProjectMetadata>): void {
  if (!project.name || typeof project.name !== 'string') {
    throw new ProjectStoreError(
      ProjectStoreErrorCode.INVALID_PROJECT_DATA,
      'Project name is required and must be a string'
    )
  }

  if (!project.database_name || typeof project.database_name !== 'string') {
    throw new ProjectStoreError(
      ProjectStoreErrorCode.INVALID_PROJECT_DATA,
      'Database name is required and must be a string'
    )
  }

  if (!project.ref || typeof project.ref !== 'string') {
    throw new ProjectStoreError(
      ProjectStoreErrorCode.INVALID_PROJECT_DATA,
      'Project ref is required and must be a string'
    )
  }

  if (!project.connection_string || typeof project.connection_string !== 'string') {
    throw new ProjectStoreError(
      ProjectStoreErrorCode.INVALID_PROJECT_DATA,
      'Connection string is required and must be a string'
    )
  }

  // Validate credential fields if provided (they can be null for legacy projects)
  if (project.database_user !== undefined && project.database_user !== null && typeof project.database_user !== 'string') {
    throw new ProjectStoreError(
      ProjectStoreErrorCode.INVALID_PROJECT_DATA,
      'Database user must be a string or null'
    )
  }

  if (project.database_password_hash !== undefined && project.database_password_hash !== null && typeof project.database_password_hash !== 'string') {
    throw new ProjectStoreError(
      ProjectStoreErrorCode.INVALID_PROJECT_DATA,
      'Database password hash must be a string or null'
    )
  }
}

/**
 * Saves a new project to the database
 */
export async function save(
  project: Omit<ProjectMetadata, 'id' | 'inserted_at' | 'updated_at'>
): Promise<WrappedResult<ProjectMetadata>> {
  try {
    validateProjectMetadata(project)
  } catch (error) {
    return {
      data: undefined,
      error:
        error instanceof ProjectStoreError
          ? error
          : new ProjectStoreError(
              ProjectStoreErrorCode.INVALID_PROJECT_DATA,
              error instanceof Error ? error.message : 'Invalid project data'
            ),
    }
  }

  const result = await executeQuery({
    query: `
      INSERT INTO _studio.studio_projects (
        ref, name, database_name, database_user, database_password_hash,
        organization_id, owner_user_id, status, region, connection_string
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
    `,
    parameters: [
      project.ref,
      project.name,
      project.database_name,
      project.database_user || null,
      project.database_password_hash || null,
      project.organization_id || 1,
      project.owner_user_id || null,
      project.status || 'ACTIVE_HEALTHY',
      project.region || 'localhost',
      project.connection_string,
    ],
  })

  if (result.error) {
    // Check for unique constraint violations
    const errorMessage = result.error.message || ''
    if (errorMessage.includes('studio_projects_ref_key')) {
      return {
        data: undefined,
        error: new ProjectStoreError(
          ProjectStoreErrorCode.PROJECT_ALREADY_EXISTS,
          `Project with ref "${project.ref}" already exists`
        ),
      }
    }
    if (errorMessage.includes('studio_projects_database_name_key')) {
      return {
        data: undefined,
        error: new ProjectStoreError(
          ProjectStoreErrorCode.PROJECT_ALREADY_EXISTS,
          `Project with database name "${project.database_name}" already exists`
        ),
      }
    }

    return {
      data: undefined,
      error: new ProjectStoreError(
        ProjectStoreErrorCode.DATABASE_ERROR,
        `Failed to save project: ${errorMessage}`,
        result.error
      ),
    }
  }

  return { data: result.data?.[0] as ProjectMetadata, error: undefined }
}

/**
 * Finds all projects
 */
export async function findAll(): Promise<WrappedResult<ProjectMetadata[]>> {
  const result = await executeQuery({
    query: 'SELECT * FROM _studio.studio_projects ORDER BY inserted_at DESC',
  })

  if (result.error) {
    return {
      data: undefined,
      error: new ProjectStoreError(
        ProjectStoreErrorCode.DATABASE_ERROR,
        `Failed to load projects: ${result.error.message}`,
        result.error
      ),
    }
  }

  return { data: (result.data || []) as ProjectMetadata[], error: undefined }
}

/**
 * Finds a project by ID
 */
export async function findById(id: number): Promise<WrappedResult<ProjectMetadata | null>> {
  const result = await executeQuery({
    query: 'SELECT * FROM _studio.studio_projects WHERE id = $1',
    parameters: [id],
  })

  if (result.error) {
    return {
      data: undefined,
      error: new ProjectStoreError(
        ProjectStoreErrorCode.DATABASE_ERROR,
        `Failed to find project: ${result.error.message}`,
        result.error
      ),
    }
  }

  return { data: (result.data?.[0] as ProjectMetadata) || null, error: undefined }
}

/**
 * Finds a project by ref
 */
export async function findByRef(ref: string): Promise<WrappedResult<ProjectMetadata | null>> {
  const result = await executeQuery({
    query: 'SELECT * FROM _studio.studio_projects WHERE ref = $1',
    parameters: [ref],
  })

  if (result.error) {
    return {
      data: undefined,
      error: new ProjectStoreError(
        ProjectStoreErrorCode.DATABASE_ERROR,
        `Failed to find project: ${result.error.message}`,
        result.error
      ),
    }
  }

  return { data: (result.data?.[0] as ProjectMetadata) || null, error: undefined }
}

/**
 * Finds a project by database name
 */
export async function findByDatabaseName(
  databaseName: string
): Promise<WrappedResult<ProjectMetadata | null>> {
  const result = await executeQuery({
    query: 'SELECT * FROM _studio.studio_projects WHERE database_name = $1',
    parameters: [databaseName],
  })

  if (result.error) {
    return {
      data: undefined,
      error: new ProjectStoreError(
        ProjectStoreErrorCode.DATABASE_ERROR,
        `Failed to find project: ${result.error.message}`,
        result.error
      ),
    }
  }

  return { data: (result.data?.[0] as ProjectMetadata) || null, error: undefined }
}

/**
 * Finds projects by organization ID
 */
export async function findByOrganizationId(
  organizationId: number
): Promise<WrappedResult<ProjectMetadata[]>> {
  const result = await executeQuery({
    query: 'SELECT * FROM _studio.studio_projects WHERE organization_id = $1 ORDER BY inserted_at DESC',
    parameters: [organizationId],
  })

  if (result.error) {
    return {
      data: undefined,
      error: new ProjectStoreError(
        ProjectStoreErrorCode.DATABASE_ERROR,
        `Failed to find projects: ${result.error.message}`,
        result.error
      ),
    }
  }

  return { data: (result.data || []) as ProjectMetadata[], error: undefined }
}

/**
 * Finds projects by owner user ID
 */
export async function findByOwnerUserId(
  ownerUserId: string
): Promise<WrappedResult<ProjectMetadata[]>> {
  const result = await executeQuery({
    query: 'SELECT * FROM _studio.studio_projects WHERE owner_user_id = $1 ORDER BY inserted_at DESC',
    parameters: [ownerUserId],
  })

  if (result.error) {
    return {
      data: undefined,
      error: new ProjectStoreError(
        ProjectStoreErrorCode.DATABASE_ERROR,
        `Failed to find projects: ${result.error.message}`,
        result.error
      ),
    }
  }

  return { data: (result.data || []) as ProjectMetadata[], error: undefined }
}

/**
 * Updates a project
 */
export async function update(
  id: number,
  updates: Partial<Omit<ProjectMetadata, 'id' | 'inserted_at' | 'updated_at'>>
): Promise<WrappedResult<ProjectMetadata>> {
  // Build dynamic UPDATE query
  const fields: string[] = []
  const parameters: any[] = []
  let paramIndex = 1

  if (updates.ref !== undefined) {
    fields.push(`ref = $${paramIndex++}`)
    parameters.push(updates.ref)
  }
  if (updates.name !== undefined) {
    fields.push(`name = $${paramIndex++}`)
    parameters.push(updates.name)
  }
  if (updates.database_name !== undefined) {
    fields.push(`database_name = $${paramIndex++}`)
    parameters.push(updates.database_name)
  }
  if (updates.database_user !== undefined) {
    fields.push(`database_user = $${paramIndex++}`)
    parameters.push(updates.database_user)
  }
  if (updates.database_password_hash !== undefined) {
    fields.push(`database_password_hash = $${paramIndex++}`)
    parameters.push(updates.database_password_hash)
  }
  if (updates.organization_id !== undefined) {
    fields.push(`organization_id = $${paramIndex++}`)
    parameters.push(updates.organization_id)
  }
  if (updates.owner_user_id !== undefined) {
    fields.push(`owner_user_id = $${paramIndex++}`)
    parameters.push(updates.owner_user_id)
  }
  if (updates.status !== undefined) {
    fields.push(`status = $${paramIndex++}`)
    parameters.push(updates.status)
  }
  if (updates.region !== undefined) {
    fields.push(`region = $${paramIndex++}`)
    parameters.push(updates.region)
  }
  if (updates.connection_string !== undefined) {
    fields.push(`connection_string = $${paramIndex++}`)
    parameters.push(updates.connection_string)
  }

  if (fields.length === 0) {
    return {
      data: undefined,
      error: new ProjectStoreError(
        ProjectStoreErrorCode.INVALID_PROJECT_DATA,
        'No fields to update'
      ),
    }
  }

  parameters.push(id)

  const result = await executeQuery({
    query: `
      UPDATE _studio.studio_projects
      SET ${fields.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING *
    `,
    parameters,
  })

  if (result.error) {
    return {
      data: undefined,
      error: new ProjectStoreError(
        ProjectStoreErrorCode.DATABASE_ERROR,
        `Failed to update project: ${result.error.message}`,
        result.error
      ),
    }
  }

  if (!result.data || result.data.length === 0) {
    return {
      data: undefined,
      error: new ProjectStoreError(
        ProjectStoreErrorCode.PROJECT_NOT_FOUND,
        `Project with ID ${id} not found`
      ),
    }
  }

  return { data: result.data[0] as ProjectMetadata, error: undefined }
}

/**
 * Deletes a project
 */
export async function deleteProject(id: number): Promise<WrappedResult<void>> {
  const result = await executeQuery({
    query: 'DELETE FROM _studio.studio_projects WHERE id = $1 RETURNING id',
    parameters: [id],
  })

  if (result.error) {
    return {
      data: undefined,
      error: new ProjectStoreError(
        ProjectStoreErrorCode.DATABASE_ERROR,
        `Failed to delete project: ${result.error.message}`,
        result.error
      ),
    }
  }

  if (!result.data || result.data.length === 0) {
    return {
      data: undefined,
      error: new ProjectStoreError(
        ProjectStoreErrorCode.PROJECT_NOT_FOUND,
        `Project with ID ${id} not found`
      ),
    }
  }

  return { data: undefined, error: undefined }
}

// Enhanced functions with credential status information

/**
 * Finds all projects with enhanced credential status information
 * 
 * @returns Result with array of all enhanced projects
 */
export async function findAllWithCredentialStatus(): Promise<WrappedResult<EnhancedProjectMetadata[]>> {
  const result = await findAll()
  if (result.error) {
    return { data: undefined, error: result.error }
  }

  const enhancedProjects = result.data!.map(enhanceProjectWithCredentialStatus)
  return { data: enhancedProjects, error: undefined }
}

/**
 * Finds a project by ref with enhanced credential status information
 * 
 * @param ref - Project ref
 * @returns Result with enhanced project or null if not found
 */
export async function findByRefWithCredentialStatus(ref: string): Promise<WrappedResult<EnhancedProjectMetadata | null>> {
  const result = await findByRef(ref)
  if (result.error) {
    return { data: undefined, error: result.error }
  }

  if (!result.data) {
    return { data: null, error: undefined }
  }

  const enhancedProject = enhanceProjectWithCredentialStatus(result.data)
  return { data: enhancedProject, error: undefined }
}

/**
 * Finds projects by organization ID with enhanced credential status information
 * 
 * @param organizationId - Organization ID
 * @returns Result with array of enhanced projects
 */
export async function findByOrganizationIdWithCredentialStatus(
  organizationId: number
): Promise<WrappedResult<EnhancedProjectMetadata[]>> {
  const result = await findByOrganizationId(organizationId)
  if (result.error) {
    return { data: undefined, error: result.error }
  }

  const enhancedProjects = result.data!.map(enhanceProjectWithCredentialStatus)
  return { data: enhancedProjects, error: undefined }
}

/**
 * Finds projects by owner user ID with enhanced credential status information
 * 
 * @param ownerUserId - GoTrue user ID
 * @returns Result with array of enhanced projects owned by the user
 */
export async function findByOwnerUserIdWithCredentialStatus(
  ownerUserId: string
): Promise<WrappedResult<EnhancedProjectMetadata[]>> {
  const result = await findByOwnerUserId(ownerUserId)
  if (result.error) {
    return { data: undefined, error: result.error }
  }

  const enhancedProjects = result.data!.map(enhanceProjectWithCredentialStatus)
  return { data: enhancedProjects, error: undefined }
}

/**
 * Gets effective credentials for a project by ref
 * 
 * @param ref - Project ref
 * @param readOnly - Whether to get read-only credentials
 * @returns Result with effective credentials information
 */
export async function getProjectEffectiveCredentials(
  ref: string,
  readOnly: boolean = false
): Promise<WrappedResult<{ user: string; password: string; usedFallback: boolean; fallbackReason?: string }>> {
  const result = await findByRef(ref)
  if (result.error) {
    return { data: undefined, error: result.error }
  }

  if (!result.data) {
    return {
      data: undefined,
      error: new ProjectStoreError(
        ProjectStoreErrorCode.PROJECT_NOT_FOUND,
        `Project with ref "${ref}" not found`,
        { ref }
      ),
    }
  }

  const effectiveCredentials = await getEffectiveCredentials(result.data, readOnly)
  return { data: effectiveCredentials, error: undefined }
}

/**
 * Updates project credentials and validates them
 * 
 * @param id - Project ID
 * @param credentials - New credentials to set
 * @returns Result with updated project
 */
export async function updateProjectCredentials(
  id: number,
  credentials: { database_user?: string | null; database_password_hash?: string | null }
): Promise<WrappedResult<ProjectMetadata>> {
  // Validate credentials if provided
  if (credentials.database_user !== undefined || credentials.database_password_hash !== undefined) {
    const fallbackManager = getCredentialFallbackManager()
    const projectCredentials = fallbackManager.getProjectCredentials(
      `project-${id}`, // Temporary ref for validation
      credentials.database_user,
      credentials.database_password_hash
    )

    // Log if we're updating to incomplete credentials
    if (!projectCredentials.isComplete) {
      console.warn(`[Project Store] Updating project ${id} with incomplete credentials`)
    }
  }

  return update(id, credentials)
}

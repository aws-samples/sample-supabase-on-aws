/**
 * Project metadata storage service for self-hosted environments.
 * Manages project metadata persistence using JSON file storage.
 */

import fs from 'fs/promises'
import path from 'path'
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
  owner_user_id?: string // GoTrue user ID - for user isolation
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
 * Project store data structure
 */
interface ProjectStoreData {
  projects: ProjectMetadata[]
  version: string
}

/**
 * Error codes for project store operations
 */
export enum ProjectStoreErrorCode {
  PROJECT_NOT_FOUND = 'PROJECT_NOT_FOUND',
  PROJECT_ALREADY_EXISTS = 'PROJECT_ALREADY_EXISTS',
  INVALID_PROJECT_DATA = 'INVALID_PROJECT_DATA',
  FILE_READ_ERROR = 'FILE_READ_ERROR',
  FILE_WRITE_ERROR = 'FILE_WRITE_ERROR',
  DIRECTORY_CREATE_ERROR = 'DIRECTORY_CREATE_ERROR',
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
 * Default storage path for project metadata
 * Using .project-data to align with other service data storage
 */
const DEFAULT_STORE_PATH = '.project-data/projects.json'

/**
 * Current store version
 */
const STORE_VERSION = '1.0.0'

/**
 * Get the storage file path from environment or use default
 */
function getStorePath(): string {
  return process.env.PROJECT_STORE_PATH || DEFAULT_STORE_PATH
}

/**
 * Ensures the storage directory exists
 */
async function ensureStorageDirectory(): Promise<WrappedResult<void>> {
  const storePath = getStorePath()
  const directory = path.dirname(storePath)

  try {
    await fs.mkdir(directory, { recursive: true })
    return { data: undefined, error: undefined }
  } catch (error) {
    return {
      data: undefined,
      error: new ProjectStoreError(
        ProjectStoreErrorCode.DIRECTORY_CREATE_ERROR,
        `Failed to create storage directory: ${directory}`,
        { directory, originalError: error }
      ),
    }
  }
}

/**
 * Reads the project store from disk
 */
async function readStore(): Promise<WrappedResult<ProjectStoreData>> {
  const storePath = getStorePath()

  try {
    const fileContent = await fs.readFile(storePath, 'utf-8')
    const data = JSON.parse(fileContent) as ProjectStoreData
    return { data, error: undefined }
  } catch (error: any) {
    // If file doesn't exist, return empty store
    if (error.code === 'ENOENT') {
      return {
        data: {
          projects: [],
          version: STORE_VERSION,
        },
        error: undefined,
      }
    }

    return {
      data: undefined,
      error: new ProjectStoreError(
        ProjectStoreErrorCode.FILE_READ_ERROR,
        `Failed to read project store: ${error.message}`,
        { storePath, originalError: error }
      ),
    }
  }
}

/**
 * Writes the project store to disk
 */
async function writeStore(data: ProjectStoreData): Promise<WrappedResult<void>> {
  const storePath = getStorePath()

  // Ensure directory exists
  const dirResult = await ensureStorageDirectory()
  if (dirResult.error) {
    return dirResult
  }

  try {
    const fileContent = JSON.stringify(data, null, 2)
    await fs.writeFile(storePath, fileContent, 'utf-8')
    return { data: undefined, error: undefined }
  } catch (error: any) {
    return {
      data: undefined,
      error: new ProjectStoreError(
        ProjectStoreErrorCode.FILE_WRITE_ERROR,
        `Failed to write project store: ${error.message}`,
        { storePath, originalError: error }
      ),
    }
  }
}

/**
 * Generates a new unique project ID
 */
function generateProjectId(existingProjects: ProjectMetadata[]): number {
  if (existingProjects.length === 0) {
    return 1
  }
  const maxId = Math.max(...existingProjects.map((p) => p.id))
  return maxId + 1
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
function getEffectiveCredentials(
  project: ProjectMetadata,
  readOnly: boolean = false
): { user: string; password: string; usedFallback: boolean; fallbackReason?: string } {
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
  const fallbackCredentials = fallbackManager.getFallbackCredentials(readOnly)
  
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

  if (project.organization_id !== undefined && typeof project.organization_id !== 'number') {
    throw new ProjectStoreError(
      ProjectStoreErrorCode.INVALID_PROJECT_DATA,
      'Organization ID must be a number'
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
 * Saves a new project to the store
 * 
 * @param project - Project metadata to save (id will be auto-generated if not provided)
 * @returns Result with the saved project including generated ID
 */
export async function save(
  project: Omit<ProjectMetadata, 'id'> & { id?: number }
): Promise<WrappedResult<ProjectMetadata>> {
  try {
    validateProjectMetadata(project)
  } catch (error) {
    return {
      data: undefined,
      error: error instanceof ProjectStoreError ? error : new ProjectStoreError(
        ProjectStoreErrorCode.INVALID_PROJECT_DATA,
        error instanceof Error ? error.message : 'Invalid project data'
      ),
    }
  }

  const storeResult = await readStore()
  if (storeResult.error) {
    return { data: undefined, error: storeResult.error }
  }

  const store = storeResult.data!

  // Check for duplicate ref
  const existingByRef = store.projects.find((p) => p.ref === project.ref)
  if (existingByRef) {
    return {
      data: undefined,
      error: new ProjectStoreError(
        ProjectStoreErrorCode.PROJECT_ALREADY_EXISTS,
        `Project with ref "${project.ref}" already exists`,
        { ref: project.ref }
      ),
    }
  }

  // Check for duplicate database name
  const existingByDbName = store.projects.find((p) => p.database_name === project.database_name)
  if (existingByDbName) {
    return {
      data: undefined,
      error: new ProjectStoreError(
        ProjectStoreErrorCode.PROJECT_ALREADY_EXISTS,
        `Project with database name "${project.database_name}" already exists`,
        { database_name: project.database_name }
      ),
    }
  }

  // Generate ID if not provided
  const id = project.id ?? generateProjectId(store.projects)

  // Check for duplicate ID
  if (store.projects.find((p) => p.id === id)) {
    return {
      data: undefined,
      error: new ProjectStoreError(
        ProjectStoreErrorCode.PROJECT_ALREADY_EXISTS,
        `Project with ID ${id} already exists`,
        { id }
      ),
    }
  }

  const now = new Date().toISOString()
  const newProject: ProjectMetadata = {
    ...project,
    id,
    inserted_at: project.inserted_at || now,
    updated_at: project.updated_at || now,
  }

  store.projects.push(newProject)

  const writeResult = await writeStore(store)
  if (writeResult.error) {
    return { data: undefined, error: writeResult.error }
  }

  return { data: newProject, error: undefined }
}

/**
 * Finds all projects in the store
 * 
 * @returns Result with array of all projects
 */
export async function findAll(): Promise<WrappedResult<ProjectMetadata[]>> {
  const storeResult = await readStore()
  if (storeResult.error) {
    return { data: undefined, error: storeResult.error }
  }

  return { data: storeResult.data!.projects, error: undefined }
}

/**
 * Finds a project by ID
 * 
 * @param id - Project ID
 * @returns Result with project or null if not found
 */
export async function findById(id: number): Promise<WrappedResult<ProjectMetadata | null>> {
  const storeResult = await readStore()
  if (storeResult.error) {
    return { data: undefined, error: storeResult.error }
  }

  const project = storeResult.data!.projects.find((p) => p.id === id) || null
  return { data: project, error: undefined }
}

/**
 * Finds a project by ref
 * 
 * @param ref - Project ref
 * @returns Result with project or null if not found
 */
export async function findByRef(ref: string): Promise<WrappedResult<ProjectMetadata | null>> {
  const storeResult = await readStore()
  if (storeResult.error) {
    return { data: undefined, error: storeResult.error }
  }

  const project = storeResult.data!.projects.find((p) => p.ref === ref) || null
  return { data: project, error: undefined }
}

/**
 * Finds a project by database name
 * 
 * @param databaseName - Database name
 * @returns Result with project or null if not found
 */
export async function findByDatabaseName(
  databaseName: string
): Promise<WrappedResult<ProjectMetadata | null>> {
  const storeResult = await readStore()
  if (storeResult.error) {
    return { data: undefined, error: storeResult.error }
  }

  const project = storeResult.data!.projects.find((p) => p.database_name === databaseName) || null
  return { data: project, error: undefined }
}

/**
 * Finds projects by organization ID
 * 
 * @param organizationId - Organization ID
 * @returns Result with array of projects
 */
export async function findByOrganizationId(
  organizationId: number
): Promise<WrappedResult<ProjectMetadata[]>> {
  const storeResult = await readStore()
  if (storeResult.error) {
    return { data: undefined, error: storeResult.error }
  }

  const projects = storeResult.data!.projects.filter((p) => p.organization_id === organizationId)
  return { data: projects, error: undefined }
}

/**
 * Finds projects by owner user ID
 * 
 * @param ownerUserId - GoTrue user ID
 * @returns Result with array of projects owned by the user
 */
export async function findByOwnerUserId(
  ownerUserId: string
): Promise<WrappedResult<ProjectMetadata[]>> {
  const storeResult = await readStore()
  if (storeResult.error) {
    return { data: undefined, error: storeResult.error }
  }

  const projects = storeResult.data!.projects.filter((p) => p.owner_user_id === ownerUserId)
  return { data: projects, error: undefined }
}

/**
 * Updates a project
 * 
 * @param id - Project ID
 * @param updates - Partial project data to update
 * @returns Result with updated project
 */
export async function update(
  id: number,
  updates: Partial<Omit<ProjectMetadata, 'id' | 'inserted_at'>>
): Promise<WrappedResult<ProjectMetadata>> {
  const storeResult = await readStore()
  if (storeResult.error) {
    return { data: undefined, error: storeResult.error }
  }

  const store = storeResult.data!
  const projectIndex = store.projects.findIndex((p) => p.id === id)

  if (projectIndex === -1) {
    return {
      data: undefined,
      error: new ProjectStoreError(
        ProjectStoreErrorCode.PROJECT_NOT_FOUND,
        `Project with ID ${id} not found`,
        { id }
      ),
    }
  }

  // Check for duplicate ref if updating ref
  if (updates.ref) {
    const existingByRef = store.projects.find((p) => p.ref === updates.ref && p.id !== id)
    if (existingByRef) {
      return {
        data: undefined,
        error: new ProjectStoreError(
          ProjectStoreErrorCode.PROJECT_ALREADY_EXISTS,
          `Project with ref "${updates.ref}" already exists`,
          { ref: updates.ref }
        ),
      }
    }
  }

  // Check for duplicate database name if updating database_name
  if (updates.database_name) {
    const existingByDbName = store.projects.find(
      (p) => p.database_name === updates.database_name && p.id !== id
    )
    if (existingByDbName) {
      return {
        data: undefined,
        error: new ProjectStoreError(
          ProjectStoreErrorCode.PROJECT_ALREADY_EXISTS,
          `Project with database name "${updates.database_name}" already exists`,
          { database_name: updates.database_name }
        ),
      }
    }
  }

  const updatedProject: ProjectMetadata = {
    ...store.projects[projectIndex],
    ...updates,
    updated_at: new Date().toISOString(),
  }

  store.projects[projectIndex] = updatedProject

  const writeResult = await writeStore(store)
  if (writeResult.error) {
    return { data: undefined, error: writeResult.error }
  }

  return { data: updatedProject, error: undefined }
}

/**
 * Deletes a project from the store
 * 
 * @param id - Project ID
 * @returns Result indicating success
 */
export async function deleteProject(id: number): Promise<WrappedResult<void>> {
  const storeResult = await readStore()
  if (storeResult.error) {
    return { data: undefined, error: storeResult.error }
  }

  const store = storeResult.data!
  const projectIndex = store.projects.findIndex((p) => p.id === id)

  if (projectIndex === -1) {
    return {
      data: undefined,
      error: new ProjectStoreError(
        ProjectStoreErrorCode.PROJECT_NOT_FOUND,
        `Project with ID ${id} not found`,
        { id }
      ),
    }
  }

  store.projects.splice(projectIndex, 1)

  const writeResult = await writeStore(store)
  if (writeResult.error) {
    return { data: undefined, error: writeResult.error }
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

  const effectiveCredentials = getEffectiveCredentials(result.data, readOnly)
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

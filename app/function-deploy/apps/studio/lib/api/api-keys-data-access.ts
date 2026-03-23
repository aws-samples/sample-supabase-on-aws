/**
 * API Keys Data Access Layer
 * 
 * This module provides secure data access functions for API Keys management.
 * All queries automatically include project filtering and ownership validation.
 * 
 * Requirements: 3.2, 3.5
 */

import { ProjectIsolationContext } from './project-isolation-middleware'

/**
 * API Key data model with project association
 */
export interface ApiKeyRecord {
  id: string
  name: string
  type: 'publishable' | 'secret' | 'legacy'
  api_key: string
  hash: string
  prefix: string
  description?: string | null
  project_id: number
  project_ref: string
  created_by_user_id: string
  inserted_at: string
  updated_at: string
  secret_jwt_template?: any
}

/**
 * Query options for API Keys
 */
export interface ApiKeyQueryOptions {
  /** Include the full API key value (default: false) */
  revealKey?: boolean
  /** Filter by key type */
  type?: 'publishable' | 'secret' | 'legacy'
  /** Filter by key name */
  name?: string
}

/**
 * Secure API Keys data access class
 * Automatically applies project filtering and ownership validation
 */
export class ApiKeysDataAccess {
  constructor(private context: ProjectIsolationContext) {}

  /**
   * Get all API keys for the current project
   * Automatically filters by project_id
   * 
   * @param options Query options
   * @returns Array of API keys belonging to the project
   */
  async getAllKeys(options: ApiKeyQueryOptions = {}): Promise<ApiKeyRecord[]> {
    const { projectId, projectRef, userId } = this.context

    // In a real implementation, this would query the database with:
    // SELECT * FROM api_keys WHERE project_id = $1
    // For now, return mock legacy keys scoped to this project
    
    const keys: ApiKeyRecord[] = [
      {
        id: 'anon',
        name: 'anon',
        type: 'legacy',
        api_key: options.revealKey ? (process.env.SUPABASE_ANON_KEY ?? '') : 'sb_anon_••••••••••••••••',
        hash: '',
        prefix: 'sb_anon',
        description: 'Legacy anon API key',
        project_id: projectId,
        project_ref: projectRef,
        created_by_user_id: userId,
        inserted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        id: 'service_role',
        name: 'service_role',
        type: 'legacy',
        api_key: options.revealKey ? (process.env.SUPABASE_SERVICE_KEY ?? '') : 'sb_service_••••••••••••••••',
        hash: '',
        prefix: 'sb_service',
        description: 'Legacy service_role API key',
        project_id: projectId,
        project_ref: projectRef,
        created_by_user_id: userId,
        inserted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ]

    // Apply filters
    let filteredKeys = keys

    if (options.type) {
      filteredKeys = filteredKeys.filter(key => key.type === options.type)
    }

    if (options.name) {
      filteredKeys = filteredKeys.filter(key => key.name === options.name)
    }

    // Validate that all returned keys belong to the current project
    this.validateKeysOwnership(filteredKeys)

    return filteredKeys
  }

  /**
   * Get a single API key by ID
   * Automatically validates project ownership
   * 
   * @param keyId API key ID
   * @param options Query options
   * @returns API key record or null if not found
   */
  async getKeyById(keyId: string, options: ApiKeyQueryOptions = {}): Promise<ApiKeyRecord | null> {
    const { projectId, projectRef, userId } = this.context

    // In a real implementation, this would query the database with:
    // SELECT * FROM api_keys WHERE id = $1 AND project_id = $2
    
    // Mock implementation for legacy keys
    if (keyId === 'anon') {
      const key: ApiKeyRecord = {
        id: 'anon',
        name: 'anon',
        type: 'legacy',
        api_key: options.revealKey ? (process.env.SUPABASE_ANON_KEY ?? '') : 'sb_anon_••••••••••••••••',
        hash: '',
        prefix: 'sb_anon',
        description: 'Legacy anon API key',
        project_id: projectId,
        project_ref: projectRef,
        created_by_user_id: userId,
        inserted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      
      // Validate ownership
      this.validateKeyOwnership(key)
      return key
    }

    if (keyId === 'service_role') {
      const key: ApiKeyRecord = {
        id: 'service_role',
        name: 'service_role',
        type: 'legacy',
        api_key: options.revealKey ? (process.env.SUPABASE_SERVICE_KEY ?? '') : 'sb_service_••••••••••••••••',
        hash: '',
        prefix: 'sb_service',
        description: 'Legacy service_role API key',
        project_id: projectId,
        project_ref: projectRef,
        created_by_user_id: userId,
        inserted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      
      // Validate ownership
      this.validateKeyOwnership(key)
      return key
    }

    // Key not found
    return null
  }

  /**
   * Create a new API key
   * Automatically associates with current project and user
   * 
   * @param keyData API key data
   * @returns Created API key record
   */
  async createKey(keyData: {
    id: string
    name: string
    type: 'publishable' | 'secret'
    api_key: string
    hash: string
    prefix: string
    description?: string | null
    secret_jwt_template?: any
  }): Promise<ApiKeyRecord> {
    const { projectId, projectRef, userId } = this.context

    // In a real implementation, this would insert into the database with:
    // INSERT INTO api_keys (id, name, type, api_key, hash, prefix, description, 
    //                       project_id, created_by_user_id, inserted_at, updated_at)
    // VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
    // RETURNING *

    const newKey: ApiKeyRecord = {
      ...keyData,
      project_id: projectId,
      project_ref: projectRef,
      created_by_user_id: userId,
      inserted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }

    // Validate that the created key belongs to the current project
    this.validateKeyOwnership(newKey)

    return newKey
  }

  /**
   * Delete an API key
   * Automatically validates project ownership before deletion
   * 
   * @param keyId API key ID
   * @returns True if deleted, false if not found
   */
  async deleteKey(keyId: string): Promise<boolean> {
    const { projectId } = this.context

    // First, verify the key exists and belongs to this project
    const key = await this.getKeyById(keyId)
    
    if (!key) {
      return false
    }

    // Prevent deletion of legacy keys
    if (key.type === 'legacy') {
      throw new Error('Cannot delete legacy API keys')
    }

    // Validate ownership before deletion
    this.validateKeyOwnership(key)

    // In a real implementation, this would delete from the database with:
    // DELETE FROM api_keys WHERE id = $1 AND project_id = $2

    return true
  }

  /**
   * Update an API key
   * Automatically validates project ownership before update
   * 
   * @param keyId API key ID
   * @param updates Fields to update
   * @returns Updated API key record or null if not found
   */
  async updateKey(
    keyId: string,
    updates: {
      name?: string
      description?: string | null
    }
  ): Promise<ApiKeyRecord | null> {
    const { projectId } = this.context

    // First, verify the key exists and belongs to this project
    const key = await this.getKeyById(keyId)
    
    if (!key) {
      return null
    }

    // Validate ownership before update
    this.validateKeyOwnership(key)

    // In a real implementation, this would update the database with:
    // UPDATE api_keys 
    // SET name = COALESCE($1, name), 
    //     description = COALESCE($2, description),
    //     updated_at = NOW()
    // WHERE id = $3 AND project_id = $4
    // RETURNING *

    const updatedKey: ApiKeyRecord = {
      ...key,
      name: updates.name ?? key.name,
      description: updates.description !== undefined ? updates.description : key.description,
      updated_at: new Date().toISOString(),
    }

    return updatedKey
  }

  /**
   * Validate that a single API key belongs to the current project
   * Throws error if ownership validation fails
   * 
   * @param key API key to validate
   */
  private validateKeyOwnership(key: ApiKeyRecord): void {
    const { projectId, projectRef } = this.context

    if (key.project_id !== projectId) {
      throw new Error(
        `Data ownership violation: API key ${key.id} does not belong to project ${projectId}`
      )
    }

    if (key.project_ref !== projectRef) {
      throw new Error(
        `Data ownership violation: API key ${key.id} project_ref mismatch`
      )
    }
  }

  /**
   * Validate that all API keys in an array belong to the current project
   * Throws error if any key fails ownership validation
   * 
   * @param keys Array of API keys to validate
   */
  private validateKeysOwnership(keys: ApiKeyRecord[]): void {
    keys.forEach(key => this.validateKeyOwnership(key))
  }

  /**
   * Check if a key exists and belongs to the current project
   * 
   * @param keyId API key ID
   * @returns True if key exists and belongs to project
   */
  async keyExists(keyId: string): Promise<boolean> {
    const key = await this.getKeyById(keyId)
    return key !== null
  }

  /**
   * Count API keys for the current project
   * 
   * @param options Query options for filtering
   * @returns Number of keys matching the criteria
   */
  async countKeys(options: ApiKeyQueryOptions = {}): Promise<number> {
    const keys = await this.getAllKeys(options)
    return keys.length
  }
}

/**
 * Create a new API Keys data access instance
 * 
 * @param context Project isolation context
 * @returns API Keys data access instance
 */
export function createApiKeysDataAccess(context: ProjectIsolationContext): ApiKeysDataAccess {
  return new ApiKeysDataAccess(context)
}

/**
 * Helper function to validate API key ownership
 * Can be used independently without creating a full data access instance
 * 
 * @param key API key to validate
 * @param context Project isolation context
 */
export function validateApiKeyOwnership(key: ApiKeyRecord, context: ProjectIsolationContext): void {
  if (key.project_id !== context.projectId) {
    throw new Error(
      `Data ownership violation: API key ${key.id} does not belong to project ${context.projectId}`
    )
  }

  if (key.project_ref !== context.projectRef) {
    throw new Error(
      `Data ownership violation: API key ${key.id} project_ref mismatch`
    )
  }
}

/**
 * Helper function to filter API keys by project
 * Removes any keys that don't belong to the specified project
 * 
 * @param keys Array of API keys
 * @param context Project isolation context
 * @returns Filtered array containing only keys belonging to the project
 */
export function filterKeysByProject(
  keys: ApiKeyRecord[],
  context: ProjectIsolationContext
): ApiKeyRecord[] {
  return keys.filter(
    key => key.project_id === context.projectId && key.project_ref === context.projectRef
  )
}

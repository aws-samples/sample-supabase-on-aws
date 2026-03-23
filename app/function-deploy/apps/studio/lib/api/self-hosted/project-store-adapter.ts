/**
 * Project Store Adapter
 * 
 * Automatically selects between JSON file storage and PostgreSQL storage
 * based on environment configuration
 */

import type { ProjectMetadata, ProjectStatus } from './project-store'
import type { WrappedResult } from './types'

// Lazy imports to avoid loading Node.js modules on client side
let JsonStore: typeof import('./project-store') | null = null
let PgStore: typeof import('./project-store-pg') | null = null

async function getJsonStore() {
  if (!JsonStore) {
    JsonStore = await import('./project-store')
  }
  return JsonStore
}

async function getPgStore() {
  if (!PgStore) {
    PgStore = await import('./project-store-pg')
  }
  return PgStore
}

/**
 * Check if PostgreSQL storage should be used
 * Default: true (PostgreSQL storage)
 * Set USE_JSON_PROJECT_STORE=true to use legacy JSON file storage
 */
function usePgStore(): boolean {
  // If explicitly set to use JSON store, use it
  if (process.env.USE_JSON_PROJECT_STORE === 'true') {
    return false
  }
  
  // Default to PostgreSQL storage
  return true
}

/**
 * Get the appropriate store implementation
 */
async function getStore() {
  return usePgStore() ? await getPgStore() : await getJsonStore()
}

/**
 * Ensure the studio_projects table exists (auto-migration)
 * This is called automatically on first database operation
 */
let tableInitialized = false
async function ensureTableExists(): Promise<void> {
  if (tableInitialized || !usePgStore()) {
    return
  }

  tableInitialized = true

  try {
    const { executeQuery } = await import('./query')

    // Check if table exists
    const checkResult = await executeQuery({
      query: `
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = '_studio' 
          AND table_name = 'studio_projects'
        );
      `,
    })

    const tableExists = (checkResult.data?.[0] as any)?.exists

    if (!tableExists) {
      console.log('[Project Store] Auto-creating studio_projects table...')

      // Create schema and table with all constraints
      await executeQuery({
        query: `
          CREATE SCHEMA IF NOT EXISTS _studio;

          CREATE TABLE IF NOT EXISTS _studio.studio_projects (
            id BIGSERIAL PRIMARY KEY,
            ref TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            database_name TEXT UNIQUE NOT NULL,
            database_user TEXT, -- Nullable for legacy projects
            database_password_hash TEXT, -- Nullable for legacy projects
            organization_id INTEGER NOT NULL DEFAULT 1,
            owner_user_id TEXT,
            status TEXT NOT NULL DEFAULT 'ACTIVE_HEALTHY',
            region TEXT NOT NULL DEFAULT 'localhost',
            connection_string TEXT NOT NULL,
            inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );

          CREATE INDEX IF NOT EXISTS idx_studio_projects_ref ON _studio.studio_projects(ref);
          CREATE INDEX IF NOT EXISTS idx_studio_projects_database_name ON _studio.studio_projects(database_name);
          CREATE INDEX IF NOT EXISTS idx_studio_projects_owner ON _studio.studio_projects(owner_user_id);
          CREATE INDEX IF NOT EXISTS idx_studio_projects_org ON _studio.studio_projects(organization_id);
          CREATE INDEX IF NOT EXISTS idx_studio_projects_status ON _studio.studio_projects(status);

          CREATE OR REPLACE FUNCTION _studio.update_studio_projects_updated_at()
          RETURNS TRIGGER AS $$
          BEGIN
            NEW.updated_at = NOW();
            RETURN NEW;
          END;
          $$ LANGUAGE plpgsql;

          DROP TRIGGER IF EXISTS trigger_studio_projects_updated_at ON _studio.studio_projects;
          CREATE TRIGGER trigger_studio_projects_updated_at
            BEFORE UPDATE ON _studio.studio_projects
            FOR EACH ROW
            EXECUTE FUNCTION _studio.update_studio_projects_updated_at();
        `,
      })

      console.log('[Project Store] ✓ Table created successfully')
    } else {
      // Check if new columns exist and add them if missing
      const columnsResult = await executeQuery({
        query: `
          SELECT column_name 
          FROM information_schema.columns 
          WHERE table_schema = '_studio' 
          AND table_name = 'studio_projects'
          AND column_name IN ('database_user', 'database_password_hash');
        `,
      })

      const existingColumns = (columnsResult.data || []).map((row: any) => row.column_name)
      
      if (!existingColumns.includes('database_user')) {
        console.log('[Project Store] Adding database_user column...')
        await executeQuery({
          query: `ALTER TABLE _studio.studio_projects ADD COLUMN database_user TEXT;`,
        })
      }
      
      if (!existingColumns.includes('database_password_hash')) {
        console.log('[Project Store] Adding database_password_hash column...')
        await executeQuery({
          query: `ALTER TABLE _studio.studio_projects ADD COLUMN database_password_hash TEXT;`,
        })
      }
    }
  } catch (error) {
    console.error('[Project Store] Failed to auto-create table:', error)
    // Reset flag to retry on next operation
    tableInitialized = false
  }
}

// Re-export types
export type { ProjectMetadata, ProjectStatus, EnhancedProjectMetadata } from './project-store'
export { ProjectStoreError, ProjectStoreErrorCode } from './project-store'

/**
 * Save a project
 */
export async function save(
  project: Omit<ProjectMetadata, 'id'> & { id?: number }
): Promise<WrappedResult<ProjectMetadata>> {
  await ensureTableExists()
  const store = await getStore()
  return store.save(project as any)
}

/**
 * Find all projects
 */
export async function findAll(): Promise<WrappedResult<ProjectMetadata[]>> {
  await ensureTableExists()
  const store = await getStore()
  return store.findAll()
}

/**
 * Find project by ID
 */
export async function findById(id: number): Promise<WrappedResult<ProjectMetadata | null>> {
  const store = await getStore()
  return store.findById(id)
}

/**
 * Find project by ref
 */
export async function findByRef(ref: string): Promise<WrappedResult<ProjectMetadata | null>> {
  const store = await getStore()
  return store.findByRef(ref)
}

/**
 * Find project by database name
 */
export async function findByDatabaseName(
  databaseName: string
): Promise<WrappedResult<ProjectMetadata | null>> {
  const store = await getStore()
  return store.findByDatabaseName(databaseName)
}

/**
 * Find projects by organization ID
 */
export async function findByOrganizationId(
  organizationId: number
): Promise<WrappedResult<ProjectMetadata[]>> {
  const store = await getStore()
  return store.findByOrganizationId(organizationId)
}

/**
 * Find projects by owner user ID
 */
export async function findByOwnerUserId(
  ownerUserId: string
): Promise<WrappedResult<ProjectMetadata[]>> {
  const store = await getStore()
  return store.findByOwnerUserId(ownerUserId)
}

/**
 * Update a project
 */
export async function update(
  id: number,
  updates: Partial<Omit<ProjectMetadata, 'id' | 'inserted_at'>>
): Promise<WrappedResult<ProjectMetadata>> {
  const store = await getStore()
  return store.update(id, updates)
}

/**
 * Delete a project
 */
export async function deleteProject(id: number): Promise<WrappedResult<void>> {
  const store = await getStore()
  return store.deleteProject(id)
}

// Enhanced functions with credential status information

/**
 * Find all projects with enhanced credential status information
 */
export async function findAllWithCredentialStatus(): Promise<WrappedResult<import('./project-store').EnhancedProjectMetadata[]>> {
  await ensureTableExists()
  const store = await getStore()
  return store.findAllWithCredentialStatus()
}

/**
 * Find project by ref with enhanced credential status information
 */
export async function findByRefWithCredentialStatus(ref: string): Promise<WrappedResult<import('./project-store').EnhancedProjectMetadata | null>> {
  const store = await getStore()
  return store.findByRefWithCredentialStatus(ref)
}

/**
 * Find projects by organization ID with enhanced credential status information
 */
export async function findByOrganizationIdWithCredentialStatus(
  organizationId: number
): Promise<WrappedResult<import('./project-store').EnhancedProjectMetadata[]>> {
  const store = await getStore()
  return store.findByOrganizationIdWithCredentialStatus(organizationId)
}

/**
 * Find projects by owner user ID with enhanced credential status information
 */
export async function findByOwnerUserIdWithCredentialStatus(
  ownerUserId: string
): Promise<WrappedResult<import('./project-store').EnhancedProjectMetadata[]>> {
  const store = await getStore()
  return store.findByOwnerUserIdWithCredentialStatus(ownerUserId)
}

/**
 * Get effective credentials for a project by ref
 */
export async function getProjectEffectiveCredentials(
  ref: string,
  readOnly: boolean = false
): Promise<WrappedResult<{ user: string; password: string; usedFallback: boolean; fallbackReason?: string }>> {
  const store = await getStore()
  return store.getProjectEffectiveCredentials(ref, readOnly)
}

/**
 * Update project credentials and validate them
 */
export async function updateProjectCredentials(
  id: number,
  credentials: { database_user?: string | null; database_password_hash?: string | null }
): Promise<WrappedResult<ProjectMetadata>> {
  const store = await getStore()
  return store.updateProjectCredentials(id, credentials)
}

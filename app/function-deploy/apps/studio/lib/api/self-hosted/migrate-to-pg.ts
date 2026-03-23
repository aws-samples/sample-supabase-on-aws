/**
 * Migration Tool: JSON to PostgreSQL
 * 
 * Migrates project data from JSON file storage to PostgreSQL
 */

import * as projectStoreJson from './project-store'
import * as projectStorePg from './project-store-pg'

export interface MigrationResult {
  success: boolean
  migratedCount: number
  skippedCount: number
  errors: Array<{ project: string; error: string }>
}

/**
 * Migrates all projects from JSON file to PostgreSQL
 */
export async function migrateJsonToPostgres(): Promise<MigrationResult> {
  console.log('[Migration] Starting migration from JSON to PostgreSQL...')

  const result: MigrationResult = {
    success: true,
    migratedCount: 0,
    skippedCount: 0,
    errors: [],
  }

  try {
    // Load projects from JSON file
    const jsonResult = await projectStoreJson.findAll()

    if (jsonResult.error) {
      console.error('[Migration] Failed to load projects from JSON:', jsonResult.error)
      result.success = false
      result.errors.push({
        project: 'ALL',
        error: `Failed to load JSON: ${jsonResult.error.message}`,
      })
      return result
    }

    const projects = jsonResult.data || []
    console.log(`[Migration] Found ${projects.length} projects in JSON file`)

    if (projects.length === 0) {
      console.log('[Migration] No projects to migrate')
      return result
    }

    // Migrate each project
    for (const project of projects) {
      try {
        // Check if project already exists in PostgreSQL
        const existingResult = await projectStorePg.findByRef(project.ref)

        if (existingResult.data) {
          console.log(`[Migration] ⊘ Project ${project.ref} already exists in PostgreSQL, skipping`)
          result.skippedCount++
          continue
        }

        // Save to PostgreSQL
        const saveResult = await projectStorePg.save({
          ref: project.ref,
          name: project.name,
          database_name: project.database_name,
          organization_id: project.organization_id,
          owner_user_id: project.owner_user_id,
          status: project.status,
          region: project.region,
          connection_string: '', // Will be generated
        })

        if (saveResult.error) {
          console.error(`[Migration] ✗ Failed to migrate project ${project.ref}:`, saveResult.error)
          result.errors.push({
            project: project.ref,
            error: saveResult.error.message,
          })
          result.success = false
        } else {
          console.log(`[Migration] ✓ Migrated project ${project.ref}`)
          result.migratedCount++
        }
      } catch (error) {
        console.error(`[Migration] ✗ Error migrating project ${project.ref}:`, error)
        result.errors.push({
          project: project.ref,
          error: error instanceof Error ? error.message : 'Unknown error',
        })
        result.success = false
      }
    }

    console.log('[Migration] Migration complete:')
    console.log(`  - Migrated: ${result.migratedCount}`)
    console.log(`  - Skipped: ${result.skippedCount}`)
    console.log(`  - Errors: ${result.errors.length}`)

    return result
  } catch (error) {
    console.error('[Migration] Fatal error during migration:', error)
    result.success = false
    result.errors.push({
      project: 'ALL',
      error: error instanceof Error ? error.message : 'Unknown error',
    })
    return result
  }
}

/**
 * Verifies that all projects from JSON exist in PostgreSQL
 */
export async function verifyMigration(): Promise<{
  verified: boolean
  missingProjects: string[]
}> {
  console.log('[Migration] Verifying migration...')

  try {
    // Load from both sources
    const jsonResult = await projectStoreJson.findAll()
    const pgResult = await projectStorePg.findAll()

    if (jsonResult.error || pgResult.error) {
      console.error('[Migration] Failed to load projects for verification')
      return { verified: false, missingProjects: [] }
    }

    const jsonProjects = jsonResult.data || []
    const pgProjects = pgResult.data || []

    const pgRefs = new Set(pgProjects.map((p) => p.ref))
    const missingProjects = jsonProjects.filter((p) => !pgRefs.has(p.ref)).map((p) => p.ref)

    if (missingProjects.length === 0) {
      console.log('[Migration] ✓ All projects verified in PostgreSQL')
      return { verified: true, missingProjects: [] }
    } else {
      console.log(`[Migration] ✗ ${missingProjects.length} projects missing in PostgreSQL:`)
      missingProjects.forEach((ref) => console.log(`  - ${ref}`))
      return { verified: false, missingProjects }
    }
  } catch (error) {
    console.error('[Migration] Error during verification:', error)
    return { verified: false, missingProjects: [] }
  }
}

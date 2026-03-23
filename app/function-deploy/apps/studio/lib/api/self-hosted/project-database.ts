/**
 * Helper functions to get database name for a project in self-hosted mode
 */

import { findProjectByRef } from './index'
import { POSTGRES_DATABASE } from './constants'

/**
 * Get the database name for a given project ref
 * Returns the default database if project not found or in case of error
 */
export async function getDatabaseNameForProject(ref: string): Promise<string> {
  // If ref is 'default', return the default database
  if (ref === 'default') {
    console.log(`[getDatabaseNameForProject] Using default database for ref: ${ref}`)
    return POSTGRES_DATABASE
  }

  try {
    console.log(`[getDatabaseNameForProject] Looking up project with ref: ${ref}`)
    const result = await findProjectByRef(ref)
    
    if (result.error || !result.data) {
      console.warn(`[getDatabaseNameForProject] Project not found for ref: ${ref}, using default database`)
      console.warn(`[getDatabaseNameForProject] Error:`, result.error)
      return POSTGRES_DATABASE
    }

    console.log(`[getDatabaseNameForProject] Found project ${ref} -> database: ${result.data.database_name}`)
    return result.data.database_name
  } catch (error) {
    console.error(`[getDatabaseNameForProject] Error getting database name for project ${ref}:`, error)
    return POSTGRES_DATABASE
  }
}

/**
 * Extract project ref from Next.js API request
 */
export function getProjectRefFromRequest(req: { query: { ref?: string | string[] } }): string | null {
  const { ref } = req.query
  
  if (typeof ref === 'string') {
    return ref
  }
  
  if (Array.isArray(ref) && ref.length > 0) {
    return ref[0]
  }
  
  return null
}

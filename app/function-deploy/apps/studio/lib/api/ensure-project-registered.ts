import { getServiceRouter } from 'lib/service-router'
import { findProjectByRef } from 'lib/api/self-hosted'

/**
 * Ensure a project is registered with the ServiceRouter before processing requests
 * 
 * This function checks if a project is already registered, and if not,
 * loads its configuration from the project store and registers it.
 * 
 * @param projectRef - The project reference to ensure is registered
 * @returns Promise that resolves when project is registered
 * @throws Error if project doesn't exist in the project store
 */
export async function ensureProjectRegistered(projectRef: string): Promise<void> {
  const serviceRouter = getServiceRouter()
  
  try {
    // Try to get the connection - if it works, project is already registered
    await serviceRouter.getConnection(projectRef)
    return
  } catch (error) {
    // Project not registered, need to load and register it
    console.log(`[ensureProjectRegistered] Project ${projectRef} not registered, loading configuration...`)
  }
  
  // Load project configuration from store
  const result = await findProjectByRef(projectRef)
  
  if (result.error || !result.data) {
    throw new Error(`Project not found: ${projectRef}`)
  }
  
  const project = result.data
  
  // Generate connection string
  const connectionString = `postgresql://${process.env.POSTGRES_USER || 'postgres'}:${process.env.POSTGRES_PASSWORD || 'postgres'}@${process.env.POSTGRES_HOST || 'localhost'}:${process.env.POSTGRES_PORT || '5432'}/${project.database_name}`
  
  // Register project with ServiceRouter
  await serviceRouter.registerProject({
    projectRef: project.ref,
    databaseName: project.database_name,
    connectionString,
    ownerUserId: project.owner_user_id || '',
    createdAt: new Date(project.inserted_at),
    updatedAt: new Date(project.inserted_at),
  })
  
  console.log(`[ensureProjectRegistered] Successfully registered project: ${projectRef}`)
}

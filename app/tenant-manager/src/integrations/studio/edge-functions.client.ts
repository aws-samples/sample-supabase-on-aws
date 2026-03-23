/**
 * Studio Edge Functions cleanup client
 * Used by tenant-manager to clean up Edge Functions when deleting a project
 */

import { BaseClient, BaseClientConfig } from '../base-client.js'

export interface CleanupResult {
  success: boolean
  deletedCount?: number
  totalFunctions?: number
  errors?: string[]
  error?: string
}

/**
 * Client for calling Studio internal APIs
 */
export class StudioEdgeFunctionsClient extends BaseClient {
  private readonly internalSecret: string | undefined

  constructor(config: BaseClientConfig & { internalSecret?: string }) {
    super(config)
    this.internalSecret = config.internalSecret
  }

  /**
   * Clean up all Edge Functions for a project
   * Calls the Studio internal API to delete all functions, metadata, and files
   */
  async cleanupProjectFunctions(projectRef: string): Promise<CleanupResult> {
    const headers: Record<string, string> = {}
    if (this.internalSecret) {
      headers['X-Internal-Secret'] = this.internalSecret
    }

    const result = await this.request<CleanupResult>({
      method: 'DELETE',
      path: `/api/internal/v1/projects/${projectRef}/functions/cleanup`,
      headers,
    })

    if (!result.ok) {
      return {
        success: false,
        error: result.error || `HTTP ${result.status}`,
      }
    }

    return result.data || { success: true }
  }
}

// Singleton instance
let client: StudioEdgeFunctionsClient | null = null

/**
 * Get the Studio Edge Functions client instance
 */
export function getStudioEdgeFunctionsClient(): StudioEdgeFunctionsClient {
  if (!client) {
    // function-deploy service runs on port 3000
    const studioUrl = process.env['STUDIO_INTERNAL_URL'] || process.env['FUNCTION_DEPLOY_URL'] || 'http://function-deploy.supabase.local:3000'
    const internalSecret = process.env['INTERNAL_API_SECRET']

    client = new StudioEdgeFunctionsClient({
      baseUrl: studioUrl,
      internalSecret,
      timeout: 30000, // 30 seconds for cleanup operations
      retries: 2,
    })
  }
  return client
}

/**
 * Clean up all Edge Functions for a project
 * Convenience function that uses the singleton client
 */
export async function cleanupProjectEdgeFunctions(projectRef: string): Promise<CleanupResult> {
  const studioClient = getStudioEdgeFunctionsClient()
  return studioClient.cleanupProjectFunctions(projectRef)
}

/**
 * Reset the client instance (for testing)
 */
export function resetStudioEdgeFunctionsClient(): void {
  client = null
}

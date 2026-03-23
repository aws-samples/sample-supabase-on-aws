import { NextApiRequest, NextApiResponse } from 'next'
import { getEdgeFunctionsClient } from 'lib/functions-service/EdgeFunctionsClient'

/**
 * Internal API endpoint for cleaning up all Edge Functions for a project
 * Called by tenant-manager during project deletion
 * 
 * DELETE /api/internal/v1/projects/[ref]/functions/cleanup
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'DELETE') {
    res.setHeader('Allow', ['DELETE'])
    return res.status(405).json({ error: 'Method not allowed' })
  }

  // Validate internal API secret
  const internalSecret = process.env.INTERNAL_API_SECRET
  if (internalSecret && req.headers['x-internal-secret'] !== internalSecret) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const { ref: projectRef } = req.query
  if (!projectRef || typeof projectRef !== 'string') {
    return res.status(400).json({ error: 'Project ref is required' })
  }

  console.log(`[Cleanup] Starting Edge Functions cleanup for project: ${projectRef}`)

  try {
    const client = getEdgeFunctionsClient()
    
    // Get all functions for the project
    const functions = await client.list(projectRef)
    
    if (functions.length === 0) {
      console.log(`[Cleanup] No Edge Functions found for project: ${projectRef}`)
      return res.status(200).json({
        success: true,
        deletedCount: 0,
        totalFunctions: 0,
        message: 'No functions to delete',
      })
    }

    console.log(`[Cleanup] Found ${functions.length} functions to delete for project: ${projectRef}`)

    // Delete each function
    let deletedCount = 0
    const errors: string[] = []
    
    for (const fn of functions) {
      try {
        await client.delete(projectRef, fn.slug)
        deletedCount++
        console.log(`[Cleanup] Deleted function: ${fn.slug}`)
      } catch (error) {
        const errorMsg = `${fn.slug}: ${error instanceof Error ? error.message : 'Unknown error'}`
        errors.push(errorMsg)
        console.error(`[Cleanup] Failed to delete function ${fn.slug}:`, error)
      }
    }

    console.log(`[Cleanup] Completed cleanup for project ${projectRef}: ${deletedCount}/${functions.length} functions deleted`)

    return res.status(200).json({
      success: errors.length === 0,
      deletedCount,
      totalFunctions: functions.length,
      errors: errors.length > 0 ? errors : undefined,
    })
  } catch (error) {
    console.error(`[Cleanup] Failed to cleanup Edge Functions for project ${projectRef}:`, error)
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
  }
}

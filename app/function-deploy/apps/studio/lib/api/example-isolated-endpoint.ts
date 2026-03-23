import { NextApiRequest, NextApiResponse } from 'next'
import { withProjectIsolation } from './project-isolation-middleware'
import { getMonitoringDataService } from './data-services'

/**
 * Example API endpoint demonstrating project isolation middleware usage
 * 
 * This endpoint shows how to:
 * 1. Use the withProjectIsolation wrapper
 * 2. Access project context automatically
 * 3. Use data services with automatic project filtering
 * 
 * Usage in pages/api/projects/[ref]/monitoring.ts:
 * 
 * export default withProjectIsolation(async (req, res, context) => {
 *   return await handleMonitoringRequest(req, res, context)
 * })
 */
export const handleMonitoringRequest = withProjectIsolation(
  async (req, res, context) => {
    const { projectId, projectRef, userId } = context

    try {
      if (req.method === 'GET') {
        // Get monitoring data for the current project
        const monitoringService = getMonitoringDataService()
        
        // Parse query parameters
        const limit = req.query.limit ? parseInt(req.query.limit as string) : 50
        const search = req.query.search as string
        
        // Data service automatically filters by project_id
        const data = await monitoringService.getMonitoringData(projectId, {
          limit,
          search
        })
        
        return {
          data,
          project: {
            id: projectId,
            ref: projectRef
          },
          meta: {
            count: data.length,
            userId
          }
        }
      }
      
      if (req.method === 'POST') {
        // Create new monitoring data
        const monitoringService = getMonitoringDataService()
        const { metric_name, metric_value, metadata } = req.body
        
        // Data service automatically associates with project_id
        const newData = await monitoringService.saveMonitoringData(projectId, {
          metric_name,
          metric_value,
          metadata,
          timestamp: new Date(),
          created_at: new Date()
        })
        
        return {
          data: newData,
          message: 'Monitoring data created successfully'
        }
      }
      
      // Method not allowed
      res.status(405).json({ error: 'Method not allowed' })
      return
      
    } catch (error) {
      console.error('Monitoring endpoint error:', error)
      res.status(500).json({
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error'
      })
      return
    }
  }
)

/**
 * Example of manual middleware usage (without the wrapper)
 * 
 * This shows how to use the middleware manually if you need more control
 */
export async function handleManualIsolation(req: NextApiRequest, res: NextApiResponse) {
  try {
    const { getProjectIsolationMiddleware } = await import('./project-isolation-middleware')
    const middleware = getProjectIsolationMiddleware()
    
    // Extract project context
    const context = await middleware.extractProjectContext(req)
    
    // Your API logic here
    const result = {
      message: 'Success',
      project: context.projectRef,
      user: context.userId
    }
    
    // Validate data ownership before returning
    const validation = middleware.validateDataOwnership(result, context.projectId)
    if (!validation.isValid) {
      return res.status(403).json({
        error: 'Access denied',
        message: validation.reason
      })
    }
    
    return res.status(200).json(result)
    
  } catch (error) {
    console.error('Manual isolation error:', error)
    return res.status(500).json({
      error: 'Project isolation failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    })
  }
}
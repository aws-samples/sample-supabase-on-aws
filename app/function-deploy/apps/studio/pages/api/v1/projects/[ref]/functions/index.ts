import { NextApiRequest, NextApiResponse } from 'next'
import { withSecureProjectAccess, ProjectIsolationContext } from 'lib/api/secure-api-wrapper'
import { getEdgeFunctionsClient } from 'lib/functions-service/EdgeFunctionsClient'
import { getFunctionListService } from 'lib/functions-service/list/FunctionListService'
import { FunctionFile } from 'lib/functions-service/storage/StorageBackend'
import { withCORS } from 'lib/functions-service/cors/CORSMiddleware'

export default withCORS(
  withSecureProjectAccess(handler, {
    permissions: { read: true, write: true }
  }),
  {
    handlePreflight: true,
    addHeaders: true,
  }
)

async function handler(req: NextApiRequest, res: NextApiResponse, context: ProjectIsolationContext) {
  const { method } = req

  switch (method) {
    case 'GET':
      return handleGetAll(req, res, context)
    case 'POST':
      return handleDeploy(req, res, context)
    default:
      res.setHeader('Allow', ['GET', 'POST'])
      res.status(405).json({ 
        error: { message: `Method ${method} Not Allowed` } 
      })
  }
}

const handleGetAll = async (req: NextApiRequest, res: NextApiResponse, context: ProjectIsolationContext) => {
  try {
    // Get project reference from context
    const { projectRef } = context

    // Use enhanced FunctionListService for comprehensive function listing with synchronization
    const functionListService = getFunctionListService()
    
    try {
      // Get all functions with enhanced metadata normalization and deployment source detection
      const functions = await functionListService.getAllFunctions(projectRef)

      // Transform enhanced metadata to API response format matching FunctionResponse schema
      const functionsData = functions.map(metadata => {
        // Enhanced API response with comprehensive metadata
        const functionData = {
          id: metadata.slug, // Use slug as ID for compatibility
          slug: metadata.slug,
          name: metadata.name,
          description: metadata.description || '',
          status: 'ACTIVE' as const,
          version: parseInt(metadata.version.split('.')[2] || '1', 10), // Extract patch version as number
          version_string: metadata.version, // Include full version string
          created_at: new Date(metadata.createdAt).getTime(),
          updated_at: new Date(metadata.updatedAt).getTime(),
          entrypoint_path: metadata.entrypoint,
          runtime: metadata.runtime,
          verify_jwt: false, // Default value, can be made configurable
          import_map: false, // Will be updated when we have import map detection
          import_map_path: undefined, // Will be updated when we have import map detection
          
          // Enhanced metadata for better function management
          project_ref: metadata.projectRef,
          user_id: metadata.userId,
          
          // Deployment source information for comprehensive tracking
          deployment_source: metadata.deploymentSource,
          metadata_loaded: metadata.metadataLoaded,
          
          // Additional metadata for debugging and management
          ...(metadata.metadataError && { metadata_error: metadata.metadataError }),
        }

        return functionData
      })

      // Get synchronization statistics for enhanced response
      const syncResult = await functionListService.syncFunctionList(projectRef)

      // Enhanced response with synchronization metadata
      const responseData = {
        functions: functionsData,
        metadata: {
          total_functions: syncResult.totalFunctions,
          ui_deployed: syncResult.uiDeployed,
          api_deployed: syncResult.apiDeployed,
          unknown_source: syncResult.unknownSource,
          last_sync: syncResult.lastSync,
          failed_metadata: syncResult.failedMetadata,
          sync_errors: syncResult.errors,
          storage_type: await functionListService.getStorageType(),
          storage_healthy: await functionListService.isStorageHealthy(),
        }
      }

      // Return functions array directly as expected by FunctionResponse[] schema
      return res.status(200).json(functionsData)
      
    } catch (listError) {
      // Enhanced error handling from FunctionListService
      console.warn(`Enhanced function list service failed for project '${projectRef}':`, listError)
      
      // Attempt fallback to EdgeFunctionsClient for backward compatibility
      try {
        console.debug(`Attempting fallback to EdgeFunctionsClient for project '${projectRef}'`)
        
        const edgeFunctionsClient = getEdgeFunctionsClient()
        const functions = await edgeFunctionsClient.list(projectRef)

        // Transform fallback data to API response format
        const fallbackData = functions.map(func => ({
          id: func.slug,
          slug: func.slug,
          name: func.name || func.slug,
          description: func.description || '',
          status: 'ACTIVE' as const,
          version: parseInt((func.version || '1.0.0').split('.')[2] || '1', 10),
          version_string: func.version || '1.0.0',
          created_at: new Date(func.createdAt || Date.now()).getTime(),
          updated_at: new Date(func.updatedAt || Date.now()).getTime(),
          entrypoint_path: func.entrypoint || 'index.ts',
          runtime: func.runtime || 'deno',
          verify_jwt: false,
          import_map: false,
          import_map_path: undefined,
          project_ref: func.projectRef || projectRef,
          user_id: func.userId || 'unknown',
          deployment_source: 'unknown', // Can't determine source from fallback
          metadata_loaded: false, // Indicate this is fallback data
          source: 'fallback',
        }))

        return res.status(200).json(fallbackData)
        
      } catch (fallbackError) {
        // Both enhanced service and fallback failed
        console.error(`Both enhanced list service and fallback failed for project '${projectRef}':`, fallbackError)
        
        // Handle enhanced error information from FunctionListService
        const functionListError = functionListService.handleListRetrievalError(listError as any)
        
        // Map function list error codes to appropriate HTTP status codes
        let statusCode = 500
        if (functionListError.code === 'STORAGE_UNAVAILABLE' || functionListError.code === 'NETWORK_ERROR') {
          statusCode = 503
        } else if (functionListError.code === 'STORAGE_ACCESS_DENIED' || functionListError.code === 'PERMISSION_ERROR') {
          statusCode = 403
        } else if (functionListError.code === 'FUNCTION_LIST_TIMEOUT') {
          statusCode = 504
        }
        
        return res.status(statusCode).json({
          error: { 
            message: functionListError.message,
            code: functionListError.code,
            retryable: functionListError.retryable,
            retryAfter: functionListError.retryAfter,
            details: functionListError.details,
            fallback_attempted: true,
            fallback_error: fallbackError instanceof Error ? fallbackError.message : 'Unknown fallback error'
          }
        })
      }
    }
  } catch (error) {
    console.error('Error listing Edge Functions:', error)
    
    // Handle specific error cases for backward compatibility
    if (error instanceof Error) {
      if (error.message.includes('storage')) {
        return res.status(503).json({
          error: { 
            message: 'Storage backend unavailable. Please check your configuration.',
            details: error.message,
            code: 'STORAGE_UNAVAILABLE',
            retryable: true,
            suggestions: [
              'Check storage backend configuration',
              'Verify storage service is running',
              'Check network connectivity to storage backend'
            ]
          }
        })
      }
      
      if (error.message.toLowerCase().includes('permission') || error.message.toLowerCase().includes('access')) {
        return res.status(403).json({
          error: { 
            message: 'Access denied to function list',
            details: error.message,
            code: 'ACCESS_DENIED',
            retryable: false,
            suggestions: [
              'Check your permissions for this project',
              'Verify you are logged in with the correct account'
            ]
          }
        })
      }
    }
    
    return res.status(500).json({
      error: { 
        message: 'Failed to list Edge Functions',
        details: error instanceof Error ? error.message : 'Unknown error',
        code: 'FUNCTION_LIST_ERROR',
        retryable: true,
        suggestions: [
          'Try refreshing the page',
          'Check your network connection',
          'Contact support if the issue persists'
        ]
      }
    })
  }
}

const handleDeploy = async (req: NextApiRequest, res: NextApiResponse, context: ProjectIsolationContext) => {
  try {
    const { projectRef, userId } = context
    const { slug, files, metadata, importMap, entrypoint } = req.body

    // Validate required fields
    if (!slug || typeof slug !== 'string') {
      return res.status(400).json({
        error: { message: 'Function slug is required' }
      })
    }

    // Validate function slug format
    if (!/^[a-z0-9][a-z0-9_\/-]*[a-z0-9]$/.test(slug)) {
      return res.status(400).json({
        error: { 
          message: 'Function slug must start and end with alphanumeric characters and contain only lowercase letters, numbers, hyphens, underscores, and forward slashes' 
        }
      })
    }

    if (!files || !Array.isArray(files) || files.length === 0) {
      return res.status(400).json({
        error: { message: 'Files array is required and must not be empty' }
      })
    }

    // Validate each file has required properties
    for (const file of files) {
      if (!file.name || file.content === undefined || file.content === null) {
        return res.status(400).json({
          error: { 
            message: 'Each file must have name and content properties' 
          }
        })
      }
      
      // Ensure file has path property (default to name if not provided)
      if (!file.path) {
        file.path = file.name
      }
    }

    // Validate import map if provided
    if (importMap) {
      try {
        JSON.parse(importMap)
      } catch (error) {
        return res.status(400).json({
          error: { 
            message: 'Import map must be valid JSON' 
          }
        })
      }
    }

    // Prepare deployment data
    const deploymentData = {
      slug,
      files: files.map(file => ({
        name: file.name,
        content: file.content,
        path: file.path || file.name,
      })),
      metadata: {
        slug,
        name: metadata?.name || slug.charAt(0).toUpperCase() + slug.slice(1),
        description: metadata?.description || '',
        version: metadata?.version || '1.0.0',
        runtime: 'deno' as const,
        entrypoint: entrypoint || 'index.ts',
        projectRef,
        userId: userId,
      },
      importMap,
      entrypoint: entrypoint || 'index.ts',
    }

    // Deploy function using EdgeFunctionsClient
    const edgeFunctionsClient = getEdgeFunctionsClient()
    const deploymentResult = await edgeFunctionsClient.deploy(projectRef, deploymentData)

    if (!deploymentResult.success) {
      return res.status(500).json({
        error: { 
          message: deploymentResult.error || 'Failed to deploy Edge Function',
          details: deploymentResult.details
        }
      })
    }

    return res.status(201).json({
      slug: deploymentResult.metadata.slug,
      projectRef,
      name: deploymentResult.metadata.name,
      version: deploymentResult.metadata.version,
      status: 'deployed',
      createdAt: deploymentResult.metadata.createdAt,
      updatedAt: deploymentResult.metadata.updatedAt,
      entrypoint: deploymentResult.metadata.entrypoint,
      runtime: deploymentResult.metadata.runtime,
    })
  } catch (error) {
    console.error('Error deploying Edge Function:', error)
    
    // Handle specific error cases
    if (error instanceof Error) {
      if (error.message.includes('Function slug')) {
        return res.status(400).json({ 
          error: { 
            message: error.message
          }
        })
      }
      
      if (error.message.includes('storage')) {
        return res.status(503).json({
          error: { 
            message: 'Storage backend unavailable. Please check your configuration.',
            details: error.message
          }
        })
      }
    }
    
    return res.status(500).json({
      error: { 
        message: 'Failed to deploy Edge Function',
        details: error instanceof Error ? error.message : 'Unknown error'
      }
    })
  }
}
import { NextApiRequest, NextApiResponse } from 'next'
import { withSecureProjectAccess, ProjectIsolationContext } from 'lib/api/secure-api-wrapper'
import { getEdgeFunctionsClient } from 'lib/functions-service/EdgeFunctionsClient'
import { FunctionFile, StorageNotFoundError } from 'lib/functions-service/storage/StorageBackend'
import { withCORS } from 'lib/functions-service/cors/CORSMiddleware'
import { getFunctionMetadataService } from 'lib/functions-service/metadata/FunctionMetadataService'
import { getFunctionErrorHandler } from 'lib/functions-service/errors/FunctionErrorHandler'

// Helper function to increment version
function incrementVersion(currentVersion: string): string {
  const parts = currentVersion.split('.')
  if (parts.length === 3) {
    const patch = parseInt(parts[2], 10) + 1
    return `${parts[0]}.${parts[1]}.${patch}`
  }
  return '1.0.1' // fallback
}

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
      return handleGet(req, res, context)
    case 'PUT':
      return handleUpdate(req, res, context)
    case 'DELETE':
      return handleDelete(req, res, context)
    default:
      res.setHeader('Allow', ['GET', 'PUT', 'DELETE'])
      res.status(405).json({ 
        error: { message: `Method ${method} Not Allowed` } 
      })
  }
}

const handleGet = async (req: NextApiRequest, res: NextApiResponse, context: ProjectIsolationContext) => {
  try {
    const { projectRef } = context
    const { slug } = req.query

    if (!slug || typeof slug !== 'string') {
      return res.status(400).json({
        data: null,
        error: { message: 'Function slug is required' }
      })
    }

    // Validate function slug format (支持多级目录)
    if (!/^[a-z0-9][a-z0-9_\/-]*[a-z0-9]$/.test(slug)) {
      return res.status(400).json({
        data: null,
        error: { 
          message: 'Function slug must start and end with alphanumeric characters and contain only lowercase letters, numbers, hyphens, underscores, and forward slashes' 
        }
      })
    }

    // Use enhanced metadata service for better error handling and fallbacks
    const metadataService = getFunctionMetadataService()
    
    try {
      // Get function metadata with enhanced error handling and validation
      const functionMetadata = await metadataService.getFunctionMetadata(projectRef, slug, {
        useFallback: true,
        normalize: true,
        validate: true
      })

      // Get function files for comprehensive metadata including import map detection
      // This will use lazy loading automatically when S3 is enabled
      const edgeFunctionsClient = getEdgeFunctionsClient()
      let hasImportMap = false
      let importMapPath: string | undefined
      let fileCount = 0
      let totalSize = 0
      let loadingSource: 'local' | 's3' | 'unknown' = 'unknown'
      
      try {
        const functionInfo = await edgeFunctionsClient.get(projectRef, slug)
        
        // Enhanced import map detection
        const importMapFile = functionInfo.files.find(file => file.name === 'import_map.json')
        hasImportMap = !!importMapFile
        importMapPath = hasImportMap ? 'import_map.json' : undefined
        
        // Calculate additional metadata
        fileCount = functionInfo.files.length
        totalSize = functionInfo.files.reduce((sum, file) => sum + (file.content?.length || 0), 0)
        
        // Determine loading source (local cache or S3)
        const isDualWriteEnabled = process.env.EDGE_FUNCTIONS_STORAGE_BACKEND === 's3'
        loadingSource = isDualWriteEnabled ? 's3' : 'local'
        
        console.debug(`[API] Function ${slug} retrieved successfully (source: ${loadingSource}, files: ${fileCount})`)
        
      } catch (error) {
        console.warn(`Could not retrieve files for function '${slug}':`, error)
        
        // Check if this is a lazy loading error from S3
        if (error instanceof Error && error.message.includes('S3')) {
          return res.status(503).json({
            error: {
              message: 'Function not available in local cache and S3 download failed',
              code: 'LAZY_LOAD_S3_ERROR',
              details: `Failed to load function ${slug} from S3 storage. The function may not have been synced to S3 yet, or there may be a network issue.`,
              suggestions: [
                'Wait a few moments and try again',
                'Check if the function was recently deployed',
                'Verify S3 storage configuration',
                'Check network connectivity to S3'
              ],
              recoverable: true,
              slug,
              projectRef
            }
          })
        }
        
        // Continue with basic metadata only for other errors
      }

      // Enhanced API response format with better metadata
      const functionData = {
        id: functionMetadata.slug, // Use slug as ID for compatibility
        slug: functionMetadata.slug,
        name: functionMetadata.name,
        description: functionMetadata.description || '',
        status: 'ACTIVE' as const,
        version: parseInt(functionMetadata.version.split('.')[2] || '1', 10), // Extract patch version as number
        version_string: functionMetadata.version, // Include full version string
        created_at: new Date(functionMetadata.createdAt).getTime(),
        updated_at: new Date(functionMetadata.updatedAt).getTime(),
        entrypoint_path: functionMetadata.entrypoint,
        runtime: functionMetadata.runtime,
        verify_jwt: false, // Default value, can be made configurable
        import_map: hasImportMap,
        import_map_path: importMapPath,
        // Enhanced metadata for better function management
        file_count: fileCount,
        total_size: totalSize,
        project_ref: functionMetadata.projectRef,
        user_id: functionMetadata.userId,
        // Indicate loading source for debugging
        loading_source: loadingSource,
      }

      return res.status(200).json(functionData)
      
    } catch (metadataError) {
      // Enhanced fallback with better error handling
      console.warn(`Enhanced metadata service failed for function '${slug}', attempting fallback:`, metadataError)
      
      // Check if this is a lazy loading error from S3
      if (metadataError instanceof Error && metadataError.message.includes('S3')) {
        return res.status(503).json({
          error: {
            message: 'Function not available in local cache and S3 download failed',
            code: 'LAZY_LOAD_S3_ERROR',
            details: `Failed to load function ${slug} from S3 storage. The function may not have been synced to S3 yet, or there may be a network issue.`,
            suggestions: [
              'Wait a few moments and try again',
              'Check if the function was recently deployed',
              'Verify S3 storage configuration',
              'Check network connectivity to S3'
            ],
            recoverable: true,
            slug,
            projectRef
          }
        })
      }
      
      try {
        const edgeFunctionsClient = getEdgeFunctionsClient()
        const functionInfo = await edgeFunctionsClient.get(projectRef, slug)

        // Create enhanced fallback metadata
        const fallbackMetadata = metadataService.createFallbackMetadata(projectRef, slug)
        
        // Enhanced API response format with fallback data
        const functionData = {
          id: functionInfo.metadata.slug || slug,
          slug: functionInfo.metadata.slug || slug,
          name: functionInfo.metadata.name || fallbackMetadata.name,
          description: functionInfo.metadata.description || fallbackMetadata.description,
          status: 'ACTIVE' as const,
          version: parseInt((functionInfo.metadata.version || fallbackMetadata.version).split('.')[2] || '1', 10),
          version_string: functionInfo.metadata.version || fallbackMetadata.version,
          created_at: new Date(functionInfo.metadata.createdAt || fallbackMetadata.createdAt).getTime(),
          updated_at: new Date(functionInfo.metadata.updatedAt || fallbackMetadata.updatedAt).getTime(),
          entrypoint_path: functionInfo.metadata.entrypoint || fallbackMetadata.entrypoint,
          runtime: functionInfo.metadata.runtime || fallbackMetadata.runtime,
          verify_jwt: false,
          import_map: functionInfo.files.some(file => file.name === 'import_map.json'),
          import_map_path: functionInfo.files.some(file => file.name === 'import_map.json') ? 'import_map.json' : undefined,
          file_count: functionInfo.files.length,
          total_size: functionInfo.files.reduce((sum, file) => sum + (file.content?.length || 0), 0),
          project_ref: functionInfo.metadata.projectRef || projectRef,
          user_id: functionInfo.metadata.userId || 'unknown',
          // Indicate this is fallback data
          metadata_source: 'fallback',
        }

        return res.status(200).json(functionData)
        
      } catch (fallbackError) {
        // If both enhanced service and fallback fail, handle gracefully
        console.error(`Both enhanced metadata service and fallback failed for function '${slug}':`, fallbackError)
        
        // Check if this is a lazy loading error from S3
        if (fallbackError instanceof Error && fallbackError.message.includes('S3')) {
          return res.status(503).json({
            error: {
              message: 'Function not available in local cache and S3 download failed',
              code: 'LAZY_LOAD_S3_ERROR',
              details: `Failed to load function ${slug} from S3 storage. The function may not have been synced to S3 yet, or there may be a network issue.`,
              suggestions: [
                'Wait a few moments and try again',
                'Check if the function was recently deployed',
                'Verify S3 storage configuration',
                'Check network connectivity to S3'
              ],
              recoverable: true,
              slug,
              projectRef,
              fallback_attempted: true
            }
          })
        }
        
        const errorHandler = getFunctionErrorHandler()
        const enhancedError = errorHandler.handleCodeRetrievalError(fallbackError, {
          projectRef,
          functionSlug: slug,
          operation: 'function metadata retrieval with fallback'
        })
        
        const statusCode = getStatusCodeForError(enhancedError.code)
        
        return res.status(statusCode).json({
          error: {
            message: enhancedError.userFeedback.message,
            code: enhancedError.code,
            details: enhancedError.userFeedback.explanation,
            suggestions: enhancedError.userFeedback.suggestions,
            recoverable: enhancedError.userFeedback.recoverable,
            fallback_attempted: true
          }
        })
      }
    }
  } catch (error) {
    console.error('Error getting Edge Function:', error)
    
    // Check if this is a lazy loading error from S3
    if (error instanceof Error && error.message.includes('S3')) {
      return res.status(503).json({
        error: {
          message: 'Function not available in local cache and S3 download failed',
          code: 'LAZY_LOAD_S3_ERROR',
          details: `Failed to load function from S3 storage. The function may not have been synced to S3 yet, or there may be a network issue.`,
          suggestions: [
            'Wait a few moments and try again',
            'Check if the function was recently deployed',
            'Verify S3 storage configuration',
            'Check network connectivity to S3'
          ],
          recoverable: true,
          projectRef: context.projectRef,
          slug: typeof req.query.slug === 'string' ? req.query.slug : 'unknown'
        }
      })
    }
    
    // Handle errors with enhanced error handler
    const errorHandler = getFunctionErrorHandler()
    const enhancedError = errorHandler.handleCodeRetrievalError(error, {
      projectRef: context.projectRef,
      functionSlug: typeof req.query.slug === 'string' ? req.query.slug : 'unknown',
      operation: 'function metadata retrieval'
    })
    
    const statusCode = getStatusCodeForError(enhancedError.code)
    
    return res.status(statusCode).json({
      error: {
        message: enhancedError.userFeedback.message,
        code: enhancedError.code,
        details: enhancedError.userFeedback.explanation,
        suggestions: enhancedError.userFeedback.suggestions,
        recoverable: enhancedError.userFeedback.recoverable
      }
    })
  }
}

const handleUpdate = async (req: NextApiRequest, res: NextApiResponse, context: ProjectIsolationContext) => {
  try {
    const { projectRef, userId } = context
    const { slug } = req.query
    const { files, metadata, importMap, entrypoint } = req.body

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

    // Get existing function to preserve some metadata
    const edgeFunctionsClient = getEdgeFunctionsClient()
    const existingFunction = await edgeFunctionsClient.getMetadata(projectRef, slug)
    
    if (!existingFunction) {
      return res.status(404).json({
        error: { message: 'Function not found' }
      })
    }

    // Prepare function files
    const functionFiles: FunctionFile[] = files.map(file => ({
      name: file.name,
      content: file.content,
      path: file.path || file.name,
    }))

    // Prepare deployment data for update
    const deploymentData = {
      slug,
      files: functionFiles,
      metadata: {
        slug,
        name: metadata?.name || existingFunction.name,
        description: metadata?.description || existingFunction.description || '',
        version: metadata?.version || incrementVersion(existingFunction.version),
        runtime: 'deno' as const,
        entrypoint: entrypoint || existingFunction.entrypoint || 'index.ts',
        projectRef,
        userId: userId,
      },
      importMap,
      entrypoint: entrypoint || existingFunction.entrypoint || 'index.ts',
    }

    // Update function using EdgeFunctionsClient (same as deploy)
    const deploymentResult = await edgeFunctionsClient.deploy(projectRef, deploymentData)

    if (!deploymentResult.success) {
      return res.status(500).json({
        error: { 
          message: deploymentResult.error || 'Failed to update Edge Function',
          details: deploymentResult.details
        }
      })
    }

    return res.status(200).json({
      slug: deploymentResult.metadata.slug,
      projectRef,
      name: deploymentResult.metadata.name,
      version: deploymentResult.metadata.version,
      status: 'deployed',
      updatedAt: deploymentResult.metadata.updatedAt,
      entrypoint: deploymentResult.metadata.entrypoint,
      runtime: deploymentResult.metadata.runtime,
    })
  } catch (error) {
    console.error('Error updating Edge Function:', error)
    
    // Handle specific error cases
    if (error instanceof StorageNotFoundError) {
      return res.status(404).json({
        error: { 
          message: 'Function not found'
        }
      })
    }
    
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
        message: 'Failed to update Edge Function',
        details: error instanceof Error ? error.message : 'Unknown error'
      }
    })
  }
}

const handleDelete = async (req: NextApiRequest, res: NextApiResponse, context: ProjectIsolationContext) => {
  try {
    const { projectRef } = context
    const { slug } = req.query

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

    // Delete function using EdgeFunctionsClient
    const edgeFunctionsClient = getEdgeFunctionsClient()
    await edgeFunctionsClient.delete(projectRef, slug)
    
    return res.status(200).json({ 
      message: `Function ${slug} deleted successfully`,
      slug,
      projectRef,
      deletedAt: new Date().toISOString()
    })
  } catch (error) {
    console.error('Error deleting Edge Function:', error)
    
    // Handle specific error cases
    if (error instanceof StorageNotFoundError) {
      return res.status(404).json({
        error: { 
          message: 'Function not found'
        }
      })
    }
    
    // Handle specific error cases for unauthorized access
    if (error instanceof Error && error.message.includes('unauthorized')) {
      return res.status(403).json({
        error: { 
          message: 'Forbidden: Insufficient permissions to delete this function'
        }
      })
    }
    
    if (error instanceof Error && error.message.includes('storage')) {
      return res.status(503).json({
        error: { 
          message: 'Storage backend unavailable. Please check your configuration.',
          details: error.message
        }
      })
    }
    
    return res.status(500).json({
      error: { 
        message: 'Failed to delete Edge Function',
        details: error instanceof Error ? error.message : 'Unknown error'
      }
    })
  }
}

// Helper function to map error codes to HTTP status codes
function getStatusCodeForError(errorCode: string): number {
  switch (errorCode) {
    case 'FUNCTION_NOT_FOUND':
    case 'METADATA_NOT_FOUND':
      return 404
    case 'FUNCTION_ACCESS_DENIED':
    case 'PERMISSION_DENIED':
      return 403
    case 'STORAGE_BACKEND_ERROR':
    case 'NETWORK_ERROR':
      return 503
    case 'OPERATION_TIMEOUT':
    case 'FUNCTION_RETRIEVAL_TIMEOUT':
      return 408
    case 'VALIDATION_ERROR':
      return 422
    default:
      return 500
  }
}
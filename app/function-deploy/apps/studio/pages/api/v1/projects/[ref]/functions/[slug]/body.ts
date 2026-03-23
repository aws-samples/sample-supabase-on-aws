import { NextApiRequest, NextApiResponse } from 'next'
import { withSecureProjectAccess, ProjectIsolationContext } from 'lib/api/secure-api-wrapper'
import { getEdgeFunctionsClient } from 'lib/functions-service/EdgeFunctionsClient'
import { withCORS } from 'lib/functions-service/cors/CORSMiddleware'
import { getFunctionCodeService } from 'lib/functions-service/code/FunctionCodeService'
import { getFunctionErrorHandler } from 'lib/functions-service/errors/FunctionErrorHandler'

export default withCORS(
  withSecureProjectAccess(handler, {
    permissions: { read: true }
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
      return handleGetBody(req, res, context)
    default:
      res.setHeader('Allow', ['GET'])
      res.status(405).json({ 
        error: { message: `Method ${method} Not Allowed` } 
      })
  }
}

const handleGetBody = async (req: NextApiRequest, res: NextApiResponse, context: ProjectIsolationContext) => {
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

    // Use enhanced function code service for better error handling and reliability
    const functionCodeService = getFunctionCodeService()
    
    try {
      // This will use lazy loading automatically when S3 is enabled
      const functionCodeResponse = await functionCodeService.getFunctionCode(projectRef, slug)

      console.debug(`[API] Function ${slug} code retrieved successfully (${functionCodeResponse.files.length} files)`)

      // Return multipart/form-data format as expected by the frontend
      const boundary = `----formdata-supabase-${Date.now()}`
      
      res.setHeader('Content-Type', `multipart/form-data; boundary=${boundary}`)
      
      let multipartBody = ''
      
      // Add each file as a part in the multipart response
      for (const file of functionCodeResponse.files) {
        multipartBody += `--${boundary}\r\n`
        multipartBody += `Content-Disposition: form-data; name="file"; filename="${file.name}"\r\n`
        multipartBody += `Content-Type: text/plain\r\n\r\n`
        multipartBody += `${file.content}\r\n`
      }
      
      multipartBody += `--${boundary}--\r\n`
      
      return res.status(200).send(multipartBody)
      
    } catch (codeError) {
      // Check if this is a lazy loading error from S3
      if (codeError instanceof Error && codeError.message.includes('S3')) {
        console.error(`[API] Lazy loading failed for function '${slug}':`, codeError.message)
        
        return res.status(503).json({
          error: {
            message: 'Function code not available in local cache and S3 download failed',
            code: 'LAZY_LOAD_S3_ERROR',
            details: `Failed to load function ${slug} code from S3 storage. The function may not have been synced to S3 yet, or there may be a network issue.`,
            suggestions: [
              'Wait a few moments and try again',
              'Check if the function was recently deployed',
              'Verify S3 storage configuration',
              'Check network connectivity to S3',
              'Try redeploying the function to ensure it is synced to S3'
            ],
            recoverable: true,
            slug,
            projectRef
          }
        })
      }
      
      // Enhanced error handling for code retrieval failures
      if (codeError && typeof codeError === 'object' && 'code' in codeError) {
        console.warn(`Function code service failed for '${slug}':`, (codeError as any).message || 'Unknown error')
        
        const errorHandler = getFunctionErrorHandler()
        const enhancedError = errorHandler.handleCodeRetrievalError(codeError, {
          projectRef,
          functionSlug: slug,
          operation: 'function code retrieval'
        })

        // Attempt graceful fallback to EdgeFunctionsClient
        try {
          console.debug(`Attempting fallback to EdgeFunctionsClient for function '${slug}'`)
          
          const edgeFunctionsClient = getEdgeFunctionsClient()
          const functionInfo = await edgeFunctionsClient.get(projectRef, slug)

          // Return multipart/form-data format for fallback data
          const boundary = `----formdata-supabase-${Date.now()}`
          
          res.setHeader('Content-Type', `multipart/form-data; boundary=${boundary}`)
          
          let multipartBody = ''
          
          // Add each file as a part in the multipart response
          for (const file of functionInfo.files) {
            multipartBody += `--${boundary}\r\n`
            multipartBody += `Content-Disposition: form-data; name="file"; filename="${file.name}"\r\n`
            multipartBody += `Content-Type: text/plain\r\n\r\n`
            multipartBody += `${file.content}\r\n`
          }
          
          multipartBody += `--${boundary}--\r\n`
          
          return res.status(200).send(multipartBody)
          
        } catch (fallbackError) {
          // Check if fallback also failed due to lazy loading
          if (fallbackError instanceof Error && fallbackError.message.includes('S3')) {
            return res.status(503).json({
              error: {
                message: 'Function code not available in local cache and S3 download failed',
                code: 'LAZY_LOAD_S3_ERROR',
                details: `Failed to load function ${slug} code from S3 storage. The function may not have been synced to S3 yet, or there may be a network issue.`,
                suggestions: [
                  'Wait a few moments and try again',
                  'Check if the function was recently deployed',
                  'Verify S3 storage configuration',
                  'Check network connectivity to S3',
                  'Try redeploying the function to ensure it is synced to S3'
                ],
                recoverable: true,
                slug,
                projectRef,
                fallback_attempted: true
              }
            })
          }
          
          // Both enhanced service and fallback failed
          console.error(`Both enhanced code service and fallback failed for function '${slug}':`, fallbackError)
          
          const statusCode = getStatusCodeForError(enhancedError.code)
          
          return res.status(statusCode).json({
            error: {
              message: enhancedError.userFeedback.message,
              code: enhancedError.code,
              details: enhancedError.userFeedback.explanation,
              suggestions: enhancedError.userFeedback.suggestions,
              recoverable: enhancedError.userFeedback.recoverable,
              fallback_attempted: true,
              fallback_error: fallbackError instanceof Error ? fallbackError.message : 'Unknown fallback error'
            }
          })
        }
      }
      
      // Handle other types of errors
      throw codeError
    }
  } catch (error) {
    console.error('Error getting Edge Function body:', error)
    
    // Check if this is a lazy loading error from S3
    if (error instanceof Error && error.message.includes('S3')) {
      return res.status(503).json({
        error: {
          message: 'Function code not available in local cache and S3 download failed',
          code: 'LAZY_LOAD_S3_ERROR',
          details: `Failed to load function code from S3 storage. The function may not have been synced to S3 yet, or there may be a network issue.`,
          suggestions: [
            'Wait a few moments and try again',
            'Check if the function was recently deployed',
            'Verify S3 storage configuration',
            'Check network connectivity to S3',
            'Try redeploying the function to ensure it is synced to S3'
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
      operation: 'function body retrieval'
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

// Helper function to map error codes to HTTP status codes
function getStatusCodeForError(errorCode: string): number {
  switch (errorCode) {
    case 'FUNCTION_NOT_FOUND':
    case 'METADATA_NOT_FOUND':
    case 'STORAGE_NOT_FOUND':
    case 'FUNCTION_FILES_NOT_FOUND':
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
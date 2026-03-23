/**
 * CORS Middleware for Edge Functions API Endpoints
 * 
 * Provides middleware functions to handle CORS preflight requests and add CORS headers
 * to API responses for Edge Functions endpoints.
 * 
 * Requirements: 19.2, 20.2
 */

import { NextApiRequest, NextApiResponse } from 'next'
import { getCORSService, CORSConfig } from './CORSConfigurationService'
import { getCORSErrorHandler, handleCORSError } from './CORSErrorHandler'

/**
 * CORS middleware options
 */
export interface CORSMiddlewareOptions {
  /** Custom CORS configuration */
  corsConfig?: Partial<CORSConfig>
  /** Whether to handle preflight requests automatically */
  handlePreflight?: boolean
  /** Whether to add CORS headers to all responses */
  addHeaders?: boolean
}

/**
 * CORS middleware for Next.js API routes
 * 
 * Handles CORS preflight requests and adds appropriate headers to responses.
 * Integrates with the CORSConfigurationService for consistent CORS behavior.
 */
export function withCORS(
  handler: (req: NextApiRequest, res: NextApiResponse) => Promise<void> | void,
  options: CORSMiddlewareOptions = {}
) {
  const {
    corsConfig,
    handlePreflight = true,
    addHeaders = true,
  } = options

  return async (req: NextApiRequest, res: NextApiResponse) => {
    const corsService = getCORSService(corsConfig)

    try {
      // Handle preflight requests (OPTIONS method)
      if (handlePreflight && req.method === 'OPTIONS') {
        console.log('[CORS Middleware] Handling preflight request for:', req.url)
        
        // Convert Next.js request to standard Request object for CORS service
        const request = createRequestFromNextApi(req)
        const corsResponse = corsService.handlePreflightRequest(request)
        
        // Apply CORS response to Next.js response
        applyCORSResponseToNextApi(corsResponse, res)
        return
      }

      // Add CORS headers to the response wrapper
      if (addHeaders) {
        const originalJson = res.json.bind(res)
        const originalSend = res.send.bind(res)
        const originalEnd = res.end.bind(res)

        // Wrap response methods to add CORS headers
        res.json = function(body: any) {
          addCORSHeadersToResponse(req, res, corsService)
          return originalJson(body)
        }

        res.send = function(body: any) {
          addCORSHeadersToResponse(req, res, corsService)
          return originalSend(body)
        }

        res.end = function(chunk?: any, encoding?: any) {
          addCORSHeadersToResponse(req, res, corsService)
          return originalEnd(chunk, encoding)
        }
      }

      // Call the original handler
      await handler(req, res)

    } catch (error) {
      console.error('[CORS Middleware] Error handling request:', error)
      
      // Log CORS-related errors with detailed information
      const errorHandler = getCORSErrorHandler()
      errorHandler.handleGeneralError(
        error instanceof Error ? error.message : 'Unknown CORS middleware error',
        {
          userAgent: req.headers['user-agent'],
          referer: req.headers.referer,
          method: req.method,
          origin: req.headers.origin,
        }
      )
      
      // Add CORS headers even to error responses
      if (addHeaders) {
        addCORSHeadersToResponse(req, res, corsService)
      }
      
      // Re-throw the error to be handled by the original handler
      throw error
    }
  }
}

/**
 * Add CORS headers to Next.js API response
 */
function addCORSHeadersToResponse(
  req: NextApiRequest,
  res: NextApiResponse,
  corsService: ReturnType<typeof getCORSService>
): void {
  const origin = req.headers.origin as string

  // Validate origin
  if (!corsService.validateOrigin(origin)) {
    console.warn('[CORS Middleware] Origin not allowed:', origin)
    
    // Log detailed error information
    const errorHandler = getCORSErrorHandler()
    const corsError = errorHandler.handleOriginNotAllowed(origin, {
      userAgent: req.headers['user-agent'],
      referer: req.headers.referer,
      method: req.method,
    })
    
    return
  }

  // Add CORS headers
  const config = corsService.getConfig()
  
  res.setHeader('Access-Control-Allow-Origin', origin || '*')
  
  if (config.allowCredentials) {
    res.setHeader('Access-Control-Allow-Credentials', 'true')
  }

  // Expose additional headers that might be useful
  const exposedHeaders = [
    'x-edge-runtime-version',
    'x-service-version',
    'x-function-name',
    'x-project-ref',
    'x-storage-backend',
    'x-execution-time',
  ]
  res.setHeader('Access-Control-Expose-Headers', exposedHeaders.join(', '))

  console.log('[CORS Middleware] Added CORS headers for origin:', origin)
}

/**
 * Convert Next.js API request to standard Request object
 */
function createRequestFromNextApi(req: NextApiRequest): Request {
  const url = `http://localhost${req.url}`
  const headers = new Headers()
  
  // Copy headers from Next.js request
  Object.entries(req.headers).forEach(([key, value]) => {
    if (typeof value === 'string') {
      headers.set(key, value)
    } else if (Array.isArray(value)) {
      headers.set(key, value.join(', '))
    }
  })

  return new Request(url, {
    method: req.method || 'GET',
    headers,
  })
}

/**
 * Apply CORS response to Next.js API response
 */
function applyCORSResponseToNextApi(corsResponse: Response, res: NextApiResponse): void {
  // Set status
  res.status(corsResponse.status)

  // Copy headers
  corsResponse.headers.forEach((value, key) => {
    res.setHeader(key, value)
  })

  // End response
  res.end()
}

/**
 * Standalone CORS preflight handler for API routes
 * 
 * Can be used directly in API routes that need custom CORS handling.
 */
export async function handleCORSPreflight(
  req: NextApiRequest,
  res: NextApiResponse,
  corsConfig?: Partial<CORSConfig>
): Promise<boolean> {
  if (req.method !== 'OPTIONS') {
    return false
  }

  console.log('[CORS Preflight] Handling preflight request for:', req.url)

  const corsService = getCORSService(corsConfig)
  const request = createRequestFromNextApi(req)
  const corsResponse = corsService.handlePreflightRequest(request)

  applyCORSResponseToNextApi(corsResponse, res)
  return true
}

/**
 * Add CORS headers to an existing Next.js API response
 */
export function addCORSHeaders(
  req: NextApiRequest,
  res: NextApiResponse,
  corsConfig?: Partial<CORSConfig>
): void {
  const corsService = getCORSService(corsConfig)
  addCORSHeadersToResponse(req, res, corsService)
}

/**
 * Validate CORS request and return validation result
 */
export function validateCORSRequest(
  req: NextApiRequest,
  corsConfig?: Partial<CORSConfig>
): {
  valid: boolean
  errors: string[]
  origin?: string
  method?: string
  headers?: string[]
} {
  const corsService = getCORSService(corsConfig)
  const origin = req.headers.origin as string
  const method = req.method || 'GET'
  const requestedHeaders = req.headers['access-control-request-headers'] as string

  const errors: string[] = []

  // Validate origin
  if (!corsService.validateOrigin(origin)) {
    errors.push(`Origin '${origin}' is not allowed`)
  }

  // Validate method
  if (!corsService.validateMethod(method)) {
    errors.push(`Method '${method}' is not allowed`)
  }

  // Validate headers if present
  let headers: string[] = []
  if (requestedHeaders) {
    headers = requestedHeaders.split(',').map(h => h.trim())
    for (const header of headers) {
      if (!corsService.validateHeader(header)) {
        errors.push(`Header '${header}' is not allowed`)
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    origin,
    method,
    headers,
  }
}

/**
 * Get CORS diagnostic information for troubleshooting
 */
export function getCORSDiagnostics(corsConfig?: Partial<CORSConfig>): Record<string, any> {
  const corsService = getCORSService(corsConfig)
  return {
    ...corsService.getDiagnosticInfo(),
    validation: corsService.validateConfiguration(),
  }
}
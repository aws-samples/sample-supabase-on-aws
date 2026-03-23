/**
 * CORS Configuration Service for Edge Functions
 * 
 * Manages Cross-Origin Resource Sharing configuration for Edge Functions service
 * to enable Studio communication and resolve CORS-related issues.
 * 
 * Requirements: 19.1, 19.4, 21.1, 21.2
 */

import { getCORSErrorHandler } from './CORSErrorHandler'

export interface CORSConfig {
  /** Allowed origins for CORS requests */
  allowedOrigins: string[]
  /** Allowed headers for CORS requests */
  allowedHeaders: string[]
  /** Allowed HTTP methods for CORS requests */
  allowedMethods: string[]
  /** Whether to allow credentials in CORS requests */
  allowCredentials: boolean
  /** Maximum age for preflight cache in seconds */
  maxAge?: number
}

export interface CORSError {
  type: 'ORIGIN_NOT_ALLOWED' | 'HEADER_NOT_ALLOWED' | 'METHOD_NOT_ALLOWED' | 'GENERAL'
  origin?: string
  header?: string
  method?: string
  message: string
}

/**
 * CORS Configuration Service Interface
 */
export interface CORSConfigurationService {
  configureCORS(config: CORSConfig): void
  handlePreflightRequest(request: Request): Response
  addCORSHeaders(response: Response, request: Request): Response
  validateOrigin(origin: string): boolean
  validateHeader(header: string): boolean
  validateMethod(method: string): boolean
  getConfig(): CORSConfig
}

/**
 * Edge Functions CORS Configuration Service Implementation
 */
export class EdgeFunctionsCORSService implements CORSConfigurationService {
  private config: CORSConfig

  constructor(config?: Partial<CORSConfig>) {
    this.config = {
      allowedOrigins: this.parseAllowedOrigins(),
      allowedHeaders: this.parseAllowedHeaders(),
      allowedMethods: this.parseAllowedMethods(),
      allowCredentials: true,
      maxAge: 86400, // 24 hours
      ...config,
    }

    console.log('[CORS Service] Initialized with config:', {
      origins: this.config.allowedOrigins.length,
      headers: this.config.allowedHeaders.length,
      methods: this.config.allowedMethods.length,
      credentials: this.config.allowCredentials,
      maxAge: this.config.maxAge,
    })
  }

  /**
   * Configure CORS settings
   */
  configureCORS(config: CORSConfig): void {
    this.config = { ...this.config, ...config }
    console.log('[CORS Service] Configuration updated:', {
      origins: this.config.allowedOrigins.length,
      headers: this.config.allowedHeaders.length,
      methods: this.config.allowedMethods.length,
    })
  }

  /**
   * Handle CORS preflight requests (OPTIONS method)
   */
  handlePreflightRequest(request: Request): Response {
    const origin = request.headers.get('origin')
    const requestedMethod = request.headers.get('access-control-request-method')
    const requestedHeaders = request.headers.get('access-control-request-headers')

    console.log('[CORS Service] Handling preflight request:', {
      origin,
      method: requestedMethod,
      headers: requestedHeaders,
    })

    // Validate origin
    if (!this.validateOrigin(origin)) {
      console.warn('[CORS Service] Origin not allowed:', origin)
      
      // Log detailed error with troubleshooting information
      const errorHandler = getCORSErrorHandler()
      errorHandler.handleOriginNotAllowed(origin || 'unknown', {
        userAgent: request.headers.get('user-agent'),
        referer: request.headers.get('referer'),
        method: requestedMethod,
      })
      
      return new Response(null, { 
        status: 403,
        statusText: 'CORS: Origin not allowed'
      })
    }

    // Validate requested method
    if (requestedMethod && !this.validateMethod(requestedMethod)) {
      console.warn('[CORS Service] Method not allowed:', requestedMethod)
      
      // Log detailed error with troubleshooting information
      const errorHandler = getCORSErrorHandler()
      errorHandler.handleMethodNotAllowed(requestedMethod, origin || 'unknown', {
        userAgent: request.headers.get('user-agent'),
        referer: request.headers.get('referer'),
      })
      
      return new Response(null, { 
        status: 403,
        statusText: 'CORS: Method not allowed'
      })
    }

    // Validate requested headers
    if (requestedHeaders) {
      const headers = requestedHeaders.split(',').map(h => h.trim().toLowerCase())
      for (const header of headers) {
        if (!this.validateHeader(header)) {
          console.warn('[CORS Service] Header not allowed:', header)
          
          // Log detailed error with troubleshooting information
          const errorHandler = getCORSErrorHandler()
          errorHandler.handleHeaderNotAllowed(header, origin || 'unknown', {
            userAgent: request.headers.get('user-agent'),
            referer: request.headers.get('referer'),
            method: requestedMethod,
          })
          
          return new Response(null, { 
            status: 403,
            statusText: 'CORS: Header not allowed'
          })
        }
      }
    }

    // Build preflight response headers
    const responseHeaders: Record<string, string> = {
      'Access-Control-Allow-Origin': origin || '*',
      'Access-Control-Allow-Methods': this.config.allowedMethods.join(', '),
      'Access-Control-Allow-Headers': this.config.allowedHeaders.join(', '),
      'Access-Control-Max-Age': (this.config.maxAge || 86400).toString(),
    }

    if (this.config.allowCredentials) {
      responseHeaders['Access-Control-Allow-Credentials'] = 'true'
    }

    console.log('[CORS Service] Preflight response headers:', responseHeaders)

    return new Response(null, {
      status: 200,
      headers: responseHeaders,
    })
  }

  /**
   * Add CORS headers to actual requests
   */
  addCORSHeaders(response: Response, request: Request): Response {
    const origin = request.headers.get('origin')

    // Only add CORS headers if origin is allowed
    if (!this.validateOrigin(origin)) {
      console.warn('[CORS Service] Origin not allowed for actual request:', origin)
      
      // Log detailed error for actual request
      const errorHandler = getCORSErrorHandler()
      errorHandler.handleOriginNotAllowed(origin || 'unknown', {
        userAgent: request.headers.get('user-agent'),
        referer: request.headers.get('referer'),
      })
      
      return response
    }

    // Clone response to modify headers
    const newResponse = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: new Headers(response.headers),
    })

    // Add CORS headers
    newResponse.headers.set('Access-Control-Allow-Origin', origin || '*')
    
    if (this.config.allowCredentials) {
      newResponse.headers.set('Access-Control-Allow-Credentials', 'true')
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
    newResponse.headers.set('Access-Control-Expose-Headers', exposedHeaders.join(', '))

    console.log('[CORS Service] Added CORS headers for origin:', origin)

    return newResponse
  }

  /**
   * Validate if an origin is allowed
   */
  validateOrigin(origin: string | null): boolean {
    if (!origin) {
      // Allow requests without origin (e.g., same-origin requests)
      return true
    }

    // Check if origin is in allowed list
    return this.config.allowedOrigins.includes(origin) || 
           this.config.allowedOrigins.includes('*')
  }

  /**
   * Validate if a header is allowed
   */
  validateHeader(header: string): boolean {
    if (!header) return true

    const normalizedHeader = header.toLowerCase()
    
    // Check if header is in allowed list
    return this.config.allowedHeaders.some(
      allowedHeader => allowedHeader.toLowerCase() === normalizedHeader
    )
  }

  /**
   * Validate if a method is allowed
   */
  validateMethod(method: string): boolean {
    if (!method) return true

    const normalizedMethod = method.toUpperCase()
    
    // Check if method is in allowed list
    return this.config.allowedMethods.some(
      allowedMethod => allowedMethod.toUpperCase() === normalizedMethod
    )
  }

  /**
   * Get current CORS configuration
   */
  getConfig(): CORSConfig {
    return { ...this.config }
  }

  /**
   * Parse allowed origins from environment variables
   */
  private parseAllowedOrigins(): string[] {
    const origins = process.env.EDGE_FUNCTIONS_CORS_ALLOWED_ORIGINS
    
    if (!origins) {
      // Default to common Studio origins for self-hosted environments
      const defaultOrigins = [
        'http://localhost:3000',
        'http://localhost:8080',
        'http://127.0.0.1:3000',
        'http://127.0.0.1:8080',
      ]

      // Add SUPABASE_PUBLIC_URL if available
      if (process.env.SUPABASE_PUBLIC_URL) {
        defaultOrigins.push(process.env.SUPABASE_PUBLIC_URL)
      }

      console.log('[CORS Service] Using default allowed origins:', defaultOrigins)
      return defaultOrigins
    }

    const parsedOrigins = origins.split(',').map(origin => origin.trim()).filter(Boolean)
    console.log('[CORS Service] Parsed allowed origins from environment:', parsedOrigins)
    return parsedOrigins
  }

  /**
   * Parse allowed headers from environment variables
   */
  private parseAllowedHeaders(): string[] {
    const headers = process.env.EDGE_FUNCTIONS_CORS_ALLOWED_HEADERS
    
    if (!headers) {
      // Default headers required for Studio functionality
      const defaultHeaders = [
        'user-agent',
        'content-type',
        'authorization',
        'x-client-info',
        'apikey',
        'x-supabase-api-version',
        'cache-control',
        'pragma',
        'accept',
        'accept-language',
        'accept-encoding',
      ]

      console.log('[CORS Service] Using default allowed headers:', defaultHeaders)
      return defaultHeaders
    }

    const parsedHeaders = headers.split(',').map(header => header.trim().toLowerCase()).filter(Boolean)
    console.log('[CORS Service] Parsed allowed headers from environment:', parsedHeaders)
    return parsedHeaders
  }

  /**
   * Parse allowed methods from environment variables
   */
  private parseAllowedMethods(): string[] {
    const methods = process.env.EDGE_FUNCTIONS_CORS_ALLOWED_METHODS
    
    if (!methods) {
      // Default methods required for Edge Functions management
      const defaultMethods = ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD']
      
      console.log('[CORS Service] Using default allowed methods:', defaultMethods)
      return defaultMethods
    }

    const parsedMethods = methods.split(',').map(method => method.trim().toUpperCase()).filter(Boolean)
    console.log('[CORS Service] Parsed allowed methods from environment:', parsedMethods)
    return parsedMethods
  }

  /**
   * Get diagnostic information for troubleshooting
   */
  getDiagnosticInfo(): Record<string, any> {
    return {
      config: this.config,
      environment: {
        EDGE_FUNCTIONS_CORS_ALLOWED_ORIGINS: process.env.EDGE_FUNCTIONS_CORS_ALLOWED_ORIGINS,
        EDGE_FUNCTIONS_CORS_ALLOWED_HEADERS: process.env.EDGE_FUNCTIONS_CORS_ALLOWED_HEADERS,
        EDGE_FUNCTIONS_CORS_ALLOWED_METHODS: process.env.EDGE_FUNCTIONS_CORS_ALLOWED_METHODS,
        SUPABASE_PUBLIC_URL: process.env.SUPABASE_PUBLIC_URL,
      },
    }
  }

  /**
   * Validate CORS configuration and provide suggestions
   */
  validateConfiguration(): {
    valid: boolean
    errors: string[]
    warnings: string[]
    suggestions: string[]
  } {
    const errors: string[] = []
    const warnings: string[] = []
    const suggestions: string[] = []

    // Check if origins are configured
    if (this.config.allowedOrigins.length === 0) {
      errors.push('No allowed origins configured')
      suggestions.push('Set EDGE_FUNCTIONS_CORS_ALLOWED_ORIGINS environment variable')
    }

    // Check if user-agent header is included (common issue)
    if (!this.config.allowedHeaders.some(h => h.toLowerCase() === 'user-agent')) {
      errors.push('user-agent header is not in allowed headers list')
      suggestions.push('Add user-agent to EDGE_FUNCTIONS_CORS_ALLOWED_HEADERS')
    }

    // Check if OPTIONS method is included
    if (!this.config.allowedMethods.includes('OPTIONS')) {
      errors.push('OPTIONS method is not in allowed methods list')
      suggestions.push('Add OPTIONS to EDGE_FUNCTIONS_CORS_ALLOWED_METHODS for preflight requests')
    }

    // Check for wildcard origin with credentials
    if (this.config.allowedOrigins.includes('*') && this.config.allowCredentials) {
      warnings.push('Using wildcard origin (*) with credentials is not allowed by browsers')
      suggestions.push('Specify explicit origins instead of wildcard when using credentials')
    }

    // Check for common Studio origins
    const commonOrigins = ['http://localhost:3000', 'http://localhost:8080']
    const hasCommonOrigins = commonOrigins.some(origin => 
      this.config.allowedOrigins.includes(origin)
    )
    
    if (!hasCommonOrigins && !this.config.allowedOrigins.includes('*')) {
      warnings.push('Common Studio development origins not found in allowed origins')
      suggestions.push('Consider adding http://localhost:3000 and http://localhost:8080 for development')
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      suggestions,
    }
  }
}

/**
 * Singleton instance
 */
let corsService: EdgeFunctionsCORSService | null = null

/**
 * Get the singleton CORS service instance
 */
export function getCORSService(config?: Partial<CORSConfig>): EdgeFunctionsCORSService {
  if (!corsService) {
    corsService = new EdgeFunctionsCORSService(config)
  }
  return corsService
}

/**
 * Reset the singleton instance (useful for testing)
 */
export function resetCORSService(): void {
  corsService = null
}

/**
 * Create CORS error with detailed information
 */
export function createCORSError(
  type: CORSError['type'],
  message: string,
  details?: { origin?: string; header?: string; method?: string }
): CORSError {
  return {
    type,
    message,
    ...details,
  }
}
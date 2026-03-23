import { NextApiRequest } from 'next'
import jwt from 'jsonwebtoken'

/**
 * Authentication helper functions for API endpoints
 */

/**
 * Authentication result interface
 */
export interface AuthenticationResult {
  userId: string | null
  error?: string
  isValid: boolean
}

/**
 * Project access result interface
 */
export interface ProjectAccessResult {
  hasAccess: boolean
  accessType: 'owner' | 'organization_member' | 'none'
  reason?: string
  organizationId?: number
}

/**
 * Get the current authenticated user ID from the request
 * 
 * @param req - Next.js API request object
 * @param projectRef - Optional project reference for project-specific JWT verification
 * @param requireProjectRef - @deprecated This parameter is no longer used. GoTrue JWT tokens do not contain project_ref claim. Project access is verified via database queries instead.
 * @returns User ID string or null if not authenticated
 */
export async function getCurrentUserId(
  req: NextApiRequest, 
  projectRef?: string,
  requireProjectRef: boolean = false
): Promise<string | null> {
  try {
    // Check for no-auth mode (for internal services)
    const noAuthMode = process.env.STUDIO_NO_AUTH_MODE === 'true'
    if (noAuthMode) {
      console.log('No-auth mode enabled, bypassing authentication')
      return 'system'
    }

    // Extract JWT token from Authorization header or cookies
    let token = extractTokenFromRequest(req)
    
    if (!token) {
      const { logAuthenticationFailure, extractErrorContextFromRequest } = await import('./error-handling')
      const context = extractErrorContextFromRequest(req, 'getCurrentUserId', { projectRef })
      logAuthenticationFailure(context, 'Authentication token missing from request')
      return null
    }

    // Check if this is a SERVICE_ROLE_KEY (role: service_role)
    if (isServiceRoleKey(token)) {
      console.log('SERVICE_ROLE_KEY detected, returning service_role identifier')
      return 'service_role'
    }
    
    // Check if this is an ANON_KEY (role: anon)
    if (isAnonKey(token)) {
      console.log('ANON_KEY detected, returning anon identifier')
      return 'anon'
    }
    
    // If no projectRef provided, try to extract it from the request
    const resolvedProjectRef = projectRef || extractProjectRefFromRequest(req)
    
    // Verify and decode the JWT token (with optional project-specific secret)
    // Note: We no longer require project_ref claim as GoTrue JWT tokens don't contain it
    // Project access is verified separately via database queries
    const decoded = await verifyJwtToken(token, resolvedProjectRef || undefined, req, false)
    
    if (!decoded) {
      // Log authentication failure - invalid token
      const { logAuthenticationFailure, extractErrorContextFromRequest } = await import('./error-handling')
      const context = extractErrorContextFromRequest(req, 'getCurrentUserId', { projectRef: resolvedProjectRef || undefined })
      logAuthenticationFailure(context, 'JWT token verification failed')
      return null
    }
    
    // Check if this is an anon role without sub (ANON_KEY)
    if (decoded.role === 'anon' && !decoded.sub) {
      console.log('ANON_KEY detected (role: anon, no sub), returning anon identifier')
      return 'anon'
    }
    
    // For authenticated users, sub is required
    if (!decoded.sub) {
      // Log authentication failure - missing subject claim
      const { logAuthenticationFailure, extractErrorContextFromRequest } = await import('./error-handling')
      const context = extractErrorContextFromRequest(req, 'getCurrentUserId', { projectRef: resolvedProjectRef || undefined })
      logAuthenticationFailure(context, 'JWT token missing subject claim')
      return null
    }
    
    return decoded.sub
    
  } catch (error) {
    // Log authentication failure - unexpected error
    const { logAuthenticationFailure, extractErrorContextFromRequest } = await import('./error-handling')
    const context = extractErrorContextFromRequest(req, 'getCurrentUserId', { projectRef })
    logAuthenticationFailure(context, `Unexpected error during authentication: ${error instanceof Error ? error.message : 'Unknown error'}`)
    
    console.error('Error getting current user ID:', error)
    return null
  }
}

/**
 * Extract project reference from request URL
 * 
 * @param req - Next.js API request object
 * @returns Project reference string or null if not found
 */
function extractProjectRefFromRequest(req: NextApiRequest): string | null {
  // Try to extract project ref from URL path
  // Common patterns: /api/v1/projects/[ref]/... or /api/platform/projects/[ref]/...
  const url = req.url || ''
  
  // Match patterns like /projects/[ref]/ or /projects/[ref]?
  const projectRefMatch = url.match(/\/projects\/([^\/\?]+)/)
  
  if (projectRefMatch && projectRefMatch[1]) {
    return projectRefMatch[1]
  }
  
  // Try to get from query parameters
  if (req.query && req.query.ref && typeof req.query.ref === 'string') {
    return req.query.ref
  }
  
  return null
}

/**
 * Extract JWT token from request (Authorization header, apikey header, or cookies)
 * 
 * @param req - Next.js API request object
 * @returns JWT token string or null if not found
 */
function extractTokenFromRequest(req: NextApiRequest): string | null {
  // Check for Authorization header (Bearer token)
  const authHeader = req.headers.authorization
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7).trim()
    if (token.length > 0) {
      console.log('[Auth] Token found in Authorization header')
      return token
    }
  }
  
  // Check for apikey header (Supabase SERVICE_ROLE_KEY)
  const apikey = req.headers.apikey as string
  if (apikey && apikey.trim().length > 0) {
    console.log('[Auth] Token found in apikey header')
    return apikey.trim()
  }
  
  // Check for session cookie (alternative auth method)
  const sessionCookie = req.cookies['supabase-auth-token'] || req.cookies['sb-access-token']
  if (sessionCookie) {
    console.log('[Auth] Token found in session cookie')
    return sessionCookie
  }
  
  // Check for access token in cookies (Supabase auth)
  const accessToken = req.cookies['sb-access-token']
  if (accessToken) {
    console.log('[Auth] Token found in access token cookie')
    return accessToken
  }
  
  // Log all available headers for debugging (without sensitive data)
  console.log('[Auth] No token found. Available headers:', {
    hasAuthorization: !!req.headers.authorization,
    hasApikey: !!req.headers.apikey,
    hasCookies: !!req.cookies && Object.keys(req.cookies).length > 0,
    cookieNames: req.cookies ? Object.keys(req.cookies) : [],
    userAgent: req.headers['user-agent'],
    endpoint: req.url
  })
  
  return null
}

/**
 * Check if a token is a SERVICE_ROLE_KEY by decoding and checking the role claim
 * 
 * @param token - JWT token string
 * @returns true if token has role: service_role
 */
function isServiceRoleKey(token: string): boolean {
  try {
    // Decode without verification to check the role claim
    const decoded = jwt.decode(token) as any
    return decoded && decoded.role === 'service_role'
  } catch (error) {
    return false
  }
}

/**
 * Check if a JWT token is an ANON_KEY
 * 
 * @param token - JWT token string
 * @returns true if token has role: anon
 */
function isAnonKey(token: string): boolean {
  try {
    // Decode without verification to check the role claim
    const decoded = jwt.decode(token) as any
    return decoded && decoded.role === 'anon'
  } catch (error) {
    return false
  }
}

/**
 * Verify JWT token signature and expiration
 * Supports both global and project-specific JWT secrets
 * 
 * @param token - JWT token string
 * @param projectRef - Optional project reference for project-specific JWT secrets
 * @param req - Optional Next.js API request for logging context
 * @param requireProjectRef - @deprecated This parameter is no longer used. GoTrue JWT tokens do not contain project_ref claim. Project access is verified via database queries instead.
 * @returns Decoded token payload or null if invalid
 */
async function verifyJwtToken(
  token: string, 
  projectRef?: string, 
  req?: NextApiRequest,
  requireProjectRef: boolean = false
): Promise<any | null> {
  try {
    // Build list of valid issuers for JWT verification (used across all verification attempts)
    const validIssuers: string[] = []
    if (process.env.SUPABASE_URL) {
      validIssuers.push(process.env.SUPABASE_URL)
    }
    if (process.env.SUPABASE_API_URL) {
      validIssuers.push(process.env.SUPABASE_API_URL)
    }
    // Also accept the external URL as a valid issuer (for tokens issued by GoTrue)
    if (process.env.GOTRUE_JWT_ISSUER) {
      validIssuers.push(process.env.GOTRUE_JWT_ISSUER)
    }
    // Accept localhost:8000 as fallback for development
    if (process.env.NODE_ENV === 'development') {
      validIssuers.push('http://localhost:8000')
    }
    
    // First, try with global JWT secret
    const globalJwtSecret = process.env.SUPABASE_JWT_SECRET || process.env.JWT_SECRET
    
    if (globalJwtSecret) {
      try {
        // Try with issuer validation first (more secure)
        const verifyOptions: jwt.VerifyOptions = {
          algorithms: ['HS256'],
        }
        
        // Add issuer validation if we have valid issuers configured
        // But only if the token actually has an issuer claim
        const decodedForIssuerCheck = jwt.decode(token) as any
        const tokenHasIssuer = decodedForIssuerCheck && decodedForIssuerCheck.iss
        
        if (validIssuers.length > 0 && tokenHasIssuer) {
          verifyOptions.issuer = validIssuers.length === 1 ? validIssuers[0] : validIssuers as [string, ...string[]]
        }
        
        const decoded = jwt.verify(token, globalJwtSecret, verifyOptions)
        
        if (typeof decoded === 'object' && decoded !== null && 'sub' in decoded) {
          // Token is valid with required user identity claims
          // Note: We no longer check for project_ref claim as GoTrue JWT doesn't include it
          // Project access is verified separately via database queries
          return decoded
        }
      } catch (globalError) {
        // Log detailed error for issuer mismatch
        // Requirements: 6.2, 6.4, 6.5
        if (globalError instanceof jwt.JsonWebTokenError) {
          const errorMessage = globalError.message
          const isIssuerError = errorMessage.includes('issuer')
          
          if (isIssuerError) {
            // Extract issuer from token for logging (without exposing the full token)
            try {
              const decodedUnsafe = jwt.decode(token) as any
              const tokenIssuer = decodedUnsafe?.iss || 'undefined'
              
              console.error('[JWT Verification] Issuer validation failed', {
                error: errorMessage,
                expectedIssuers: validIssuers.length > 0 ? validIssuers : 'none configured',
                tokenIssuer,
                userId: decodedUnsafe?.sub || 'unknown',
                projectRef: decodedUnsafe?.project_ref || projectRef || 'unknown',
                // Note: Full token and secrets are NOT logged for security
              })
            } catch (decodeError) {
              console.error('[JWT Verification] Issuer validation failed (unable to decode token)', {
                error: errorMessage,
                expectedIssuers: validIssuers.length > 0 ? validIssuers : 'none configured',
              })
            }
          } else {
            console.warn('[JWT Verification] Token validation failed:', errorMessage)
          }
        }
        
        // If global secret fails and we have a project reference, try project-specific secret
        if (projectRef) {
          console.log('Global JWT verification failed, trying project-specific secret for project:', projectRef)
        } else {
          // No project reference, so we can't try project-specific secret
          // Log the authentication failure
          if (req) {
            const { logAuthenticationFailure, extractErrorContextFromRequest } = await import('./error-handling')
            const context = extractErrorContextFromRequest(req, 'verifyJwtToken', { projectRef })
            const errorMessage = globalError instanceof jwt.TokenExpiredError 
              ? 'JWT token expired'
              : globalError instanceof jwt.JsonWebTokenError
              ? `JWT token invalid: ${globalError.message}`
              : 'JWT verification failed'
            logAuthenticationFailure(context, errorMessage)
          }
          throw globalError
        }
      }
    }
    
    // Try project-specific JWT secret if available
    if (projectRef) {
      const projectJwtSecret = await getProjectJwtSecret(projectRef)
      
      if (projectJwtSecret) {
        try {
          const decoded = jwt.verify(token, projectJwtSecret, {
            algorithms: ['HS256'],
          })
          
          if (typeof decoded === 'object' && decoded !== null && 'sub' in decoded) {
            console.log('Successfully verified JWT with project-specific secret for project:', projectRef)
            // Token is valid with required user identity claims
            // Note: We no longer check for project_ref claim
            return decoded
          }
        } catch (projectError: any) {
          // Log detailed error for issuer mismatch with project-specific secret
          // Requirements: 6.2, 6.4, 6.5
          if (projectError instanceof jwt.JsonWebTokenError) {
            const errorMessage = projectError.message
            const isIssuerError = errorMessage.includes('issuer')
            
            if (isIssuerError) {
              // Extract issuer from token for logging (without exposing the full token)
              try {
                const decodedUnsafe = jwt.decode(token) as any
                const tokenIssuer = decodedUnsafe?.iss || 'undefined'
                
                console.error('[JWT Verification] Project-specific issuer validation failed', {
                  error: errorMessage,
                  projectRef,
                  tokenIssuer,
                  userId: decodedUnsafe?.sub || 'unknown',
                  projectRefInToken: decodedUnsafe?.project_ref || 'unknown',
                  // Note: Full token and secrets are NOT logged for security
                })
              } catch (decodeError) {
                console.error('[JWT Verification] Project-specific issuer validation failed (unable to decode token)', {
                  error: errorMessage,
                  projectRef,
                })
              }
            } else {
              console.warn('Project-specific JWT verification also failed for project:', projectRef, projectError?.message || 'Unknown error')
            }
          } else {
            console.warn('Project-specific JWT verification also failed for project:', projectRef, projectError?.message || 'Unknown error')
          }
          
          // Log the authentication failure
          if (req) {
            const { logAuthenticationFailure, extractErrorContextFromRequest } = await import('./error-handling')
            const context = extractErrorContextFromRequest(req, 'verifyJwtToken', { projectRef })
            const errorMessage = projectError instanceof jwt.TokenExpiredError 
              ? 'JWT token expired'
              : projectError instanceof jwt.JsonWebTokenError
              ? `JWT token invalid: ${projectError.message}`
              : 'JWT verification failed with project-specific secret'
            logAuthenticationFailure(context, errorMessage)
          }
        }
      }
    }
    
    return null
    
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      console.warn('JWT token expired:', error.message)
    } else if (error instanceof jwt.JsonWebTokenError) {
      console.warn('JWT token invalid:', error.message)
    } else {
      console.error('JWT verification error:', error)
    }
    return null
  }
}

/**
 * Get project-specific JWT secret from project settings
 * 
 * @param projectRef - Project reference
 * @returns JWT secret string or null if not found
 */
async function getProjectJwtSecret(projectRef: string): Promise<string | null> {
  try {
    // Skip project-specific secret lookup for special endpoints that don't represent actual projects
    const specialEndpoints = ['create', 'index', 'list']
    if (specialEndpoints.includes(projectRef)) {
      return null
    }
    
    // Import the project store functions to get project information
    const { findByRef } = await import('./self-hosted/project-store-pg')
    
    // First check if the project exists
    const projectResult = await findByRef(projectRef)
    
    if (projectResult.error || !projectResult.data) {
      console.warn('Project not found for JWT secret lookup:', projectRef)
      return null
    }
    
    // Try to get project-specific JWT secret from various sources
    
    // 1. Check if there's a project-specific JWT secret in environment variables
    const projectSpecificSecret = process.env[`JWT_SECRET_${projectRef.toUpperCase()}`] || 
                                  process.env[`SUPABASE_JWT_SECRET_${projectRef.toUpperCase()}`]
    
    if (projectSpecificSecret) {
      return projectSpecificSecret
    }
    
    // 2. Try to get from the legacy JWT secret endpoint (simulated)
    // In a real implementation, this might query a database or configuration store
    // For now, we'll use the same global secret as fallback
    const legacySecret = process.env.SUPABASE_JWT_SECRET || process.env.JWT_SECRET
    
    if (legacySecret) {
      console.log('Using legacy JWT secret for project:', projectRef)
      return legacySecret
    }
    
    return null
    
  } catch (error) {
    console.error('Error getting project JWT secret:', error)
    return null
  }
}

/**
 * Get project-specific JWT secret from Legacy JWT Secret endpoint
 * This function simulates calling the legacy JWT secret API
 * 
 * @param projectRef - Project reference
 * @returns JWT secret string or null if not found
 */
export async function getProjectLegacyJwtSecret(projectRef: string): Promise<string | null> {
  try {
    // In a real implementation, this would make an internal API call to:
    // GET /api/v1/projects/[ref]/config/auth/signing-keys/legacy
    
    // For now, we'll simulate the logic from the legacy endpoint
    const jwtSecret = process.env.SUPABASE_JWT_SECRET || process.env.JWT_SECRET
    
    if (!jwtSecret) {
      console.warn('No JWT secret configured for project:', projectRef)
      return null
    }
    
    // Verify the project exists first
    const { findByRef } = await import('./self-hosted/project-store-pg')
    const projectResult = await findByRef(projectRef)
    
    if (projectResult.error || !projectResult.data) {
      console.warn('Project not found for legacy JWT secret:', projectRef)
      return null
    }
    
    console.log('Retrieved legacy JWT secret for project:', projectRef)
    return jwtSecret
    
  } catch (error) {
    console.error('Error getting project legacy JWT secret:', error)
    return null
  }
}

/**
 * Validate JWT token with multiple secret sources
 * This function tries different JWT secrets in order of preference
 * 
 * @param token - JWT token string
 * @param projectRef - Project reference
 * @returns Validation result with decoded token and secret source used
 */
export async function validateJwtTokenWithMultipleSources(
  token: string, 
  projectRef?: string
): Promise<{
  isValid: boolean
  decoded: any | null
  secretSource: 'global' | 'project-specific' | 'legacy' | null
  projectRef?: string
}> {
  const result: {
    isValid: boolean
    decoded: any | null
    secretSource: 'global' | 'project-specific' | 'legacy' | null
    projectRef?: string
  } = {
    isValid: false,
    decoded: null,
    secretSource: null,
    projectRef
  }
  
  try {
    // Build list of valid issuers for JWT verification
    const validIssuers: string[] = []
    if (process.env.SUPABASE_URL) {
      validIssuers.push(process.env.SUPABASE_URL)
    }
    if (process.env.SUPABASE_API_URL) {
      validIssuers.push(process.env.SUPABASE_API_URL)
    }
    // Also accept the external URL as a valid issuer (for tokens issued by GoTrue)
    if (process.env.GOTRUE_JWT_ISSUER) {
      validIssuers.push(process.env.GOTRUE_JWT_ISSUER)
    }
    // Accept localhost:8000 as fallback for development
    if (process.env.NODE_ENV === 'development') {
      validIssuers.push('http://localhost:8000')
    }
    
    // 1. Try global JWT secret first
    const globalJwtSecret = process.env.SUPABASE_JWT_SECRET || process.env.JWT_SECRET
    
    if (globalJwtSecret) {
      try {
        const decoded = jwt.verify(token, globalJwtSecret, {
          algorithms: ['HS256'],
          issuer: process.env.SUPABASE_URL || undefined,
        })
        
        if (typeof decoded === 'object' && decoded !== null && 'sub' in decoded) {
          result.isValid = true
          result.decoded = decoded
          result.secretSource = 'global'
          return result
        }
      } catch (globalError) {
        // Continue to try project-specific secrets
      }
    }
    
    // 2. Try project-specific secrets if projectRef is provided
    if (projectRef) {
      // Try project-specific environment variable
      const projectSpecificSecret = process.env[`JWT_SECRET_${projectRef.toUpperCase()}`] || 
                                    process.env[`SUPABASE_JWT_SECRET_${projectRef.toUpperCase()}`]
      
      if (projectSpecificSecret) {
        try {
          // Try with issuer validation first if we have valid issuers
          const verifyOptions: jwt.VerifyOptions = {
            algorithms: ['HS256'],
          }
          
          if (validIssuers.length > 0) {
            verifyOptions.issuer = validIssuers.length === 1 ? validIssuers[0] : validIssuers as [string, ...string[]]
          }
          
          const decoded = jwt.verify(token, projectSpecificSecret, verifyOptions)
          
          if (typeof decoded === 'object' && decoded !== null && 'sub' in decoded) {
            result.isValid = true
            result.decoded = decoded
            result.secretSource = 'project-specific'
            return result
          }
        } catch (issuerError) {
          // Log detailed error for issuer mismatch
          // Requirements: 6.2, 6.4, 6.5
          if (issuerError instanceof jwt.JsonWebTokenError) {
            const errorMessage = issuerError.message
            const isIssuerError = errorMessage.includes('issuer')
            
            if (isIssuerError) {
              // Extract issuer from token for logging (without exposing the full token)
              try {
                const decodedUnsafe = jwt.decode(token) as any
                const tokenIssuer = decodedUnsafe?.iss || 'undefined'
                
                console.error('[JWT Verification] Project-specific issuer validation failed', {
                  error: errorMessage,
                  expectedIssuers: validIssuers.length > 0 ? validIssuers : 'none configured',
                  tokenIssuer,
                  projectRef,
                  userId: decodedUnsafe?.sub || 'unknown',
                  projectRefInToken: decodedUnsafe?.project_ref || 'unknown',
                  // Note: Full token and secrets are NOT logged for security
                })
              } catch (decodeError) {
                console.error('[JWT Verification] Project-specific issuer validation failed (unable to decode token)', {
                  error: errorMessage,
                  projectRef,
                  expectedIssuers: validIssuers.length > 0 ? validIssuers : 'none configured',
                })
              }
            }
          }
          
          // Do not fallback to lenient validation - issuer check is required for security
          console.warn('[JWT Verification] Project-specific token rejected due to issuer validation failure:', 
            issuerError instanceof jwt.JsonWebTokenError ? issuerError.message : 'Unknown error')
          // Continue to try legacy secret
        }
      }
      
      // 3. Try legacy JWT secret
      const legacySecret = await getProjectLegacyJwtSecret(projectRef)
      
      if (legacySecret && legacySecret !== globalJwtSecret) {
        try {
          // Try with issuer validation first if we have valid issuers
          const verifyOptions: jwt.VerifyOptions = {
            algorithms: ['HS256'],
          }
          
          if (validIssuers.length > 0) {
            verifyOptions.issuer = validIssuers.length === 1 ? validIssuers[0] : validIssuers as [string, ...string[]]
          }
          
          const decoded = jwt.verify(token, legacySecret, verifyOptions)
          
          if (typeof decoded === 'object' && decoded !== null && 'sub' in decoded) {
            result.isValid = true
            result.decoded = decoded
            result.secretSource = 'legacy'
            return result
          }
        } catch (issuerError) {
          // Log detailed error for issuer mismatch with legacy secret
          // Requirements: 6.2, 6.4, 6.5
          if (issuerError instanceof jwt.JsonWebTokenError) {
            const errorMessage = issuerError.message
            const isIssuerError = errorMessage.includes('issuer')
            
            if (isIssuerError) {
              // Extract issuer from token for logging (without exposing the full token)
              try {
                const decodedUnsafe = jwt.decode(token) as any
                const tokenIssuer = decodedUnsafe?.iss || 'undefined'
                
                console.error('[JWT Verification] Legacy secret issuer validation failed', {
                  error: errorMessage,
                  expectedIssuers: validIssuers.length > 0 ? validIssuers : 'none configured',
                  tokenIssuer,
                  projectRef,
                  userId: decodedUnsafe?.sub || 'unknown',
                  projectRefInToken: decodedUnsafe?.project_ref || 'unknown',
                  // Note: Full token and secrets are NOT logged for security
                })
              } catch (decodeError) {
                console.error('[JWT Verification] Legacy secret issuer validation failed (unable to decode token)', {
                  error: errorMessage,
                  projectRef,
                  expectedIssuers: validIssuers.length > 0 ? validIssuers : 'none configured',
                })
              }
            }
          }
          
          // Do not fallback to lenient validation - issuer check is required for security
          console.warn('[JWT Verification] Legacy token rejected due to issuer validation failure:', 
            issuerError instanceof jwt.JsonWebTokenError ? issuerError.message : 'Unknown error')
          // All attempts failed
        }
      }
    }
    
    return result
    
  } catch (error) {
    console.error('Error validating JWT token with multiple sources:', error)
    return result
  }
}

/**
 * Validate that a user has access to a specific project
 * 
 * @param userId - User ID
 * @param projectId - Project ID
 * @returns ProjectAccessResult with access information
 */
export async function validateUserProjectAccess(
  userId: string, 
  projectId: number
): Promise<ProjectAccessResult> {
  const startTime = Date.now()
  
  try {
    // No-auth mode: allow all access
    const noAuthMode = process.env.STUDIO_NO_AUTH_MODE === 'true'
    if (noAuthMode) {
      console.log('[validateUserProjectAccess] No-auth mode: allowing access')
      return {
        hasAccess: true,
        accessType: 'owner'
      }
    }

    if (!userId || !projectId) {
      return {
        hasAccess: false,
        accessType: 'none',
        reason: 'Invalid userId or projectId'
      }
    }

    // Import the project store functions
    const { findById, findByOrganizationId } = await import('./self-hosted/project-store-pg')
    
    // First, check if user is the direct owner of the project
    const projectResult = await findById(projectId)
    
    if (projectResult.error) {
      console.error('[validateUserProjectAccess] Error finding project:', projectResult.error)
      return {
        hasAccess: false,
        accessType: 'none',
        reason: 'Database error while checking project access'
      }
    }
    
    if (!projectResult.data) {
      return {
        hasAccess: false,
        accessType: 'none',
        reason: 'Project not found'
      }
    }
    
    const project = projectResult.data
    
    // Check if user is the direct owner
    if (project.owner_user_id === userId) {
      const executionTimeMs = Date.now() - startTime
      
      // Log performance metrics
      console.log('[validateUserProjectAccess] Validation completed', {
        userId,
        projectId,
        executionTimeMs,
        meetsRequirement: executionTimeMs < 100,
        accessType: 'owner'
      })
      
      return {
        hasAccess: true,
        accessType: 'owner',
        organizationId: project.organization_id
      }
    }
    
    // Check if user has access through organization membership
    // TODO: Implement proper organization membership table
    // For now, we'll disable organization-based access to ensure strict project isolation
    // Only direct project owners should have access
    
    // SECURITY FIX: Removed flawed organization membership logic
    // The previous logic allowed any user who owned a project in an organization
    // to access ALL projects in that organization, which is a security vulnerability.
    // 
    // Proper organization membership should be implemented with:
    // 1. An organization_members table with explicit user-organization relationships
    // 2. Role-based permissions (admin, member, viewer, etc.)
    // 3. Project-specific permissions within organizations
    //
    // Until proper organization membership is implemented, we only allow
    // direct project owners to access their projects.
    
    /*
    if (project.organization_id) {
      // Get all projects in the same organization
      const orgProjectsResult = await findByOrganizationId(project.organization_id)
      
      if (orgProjectsResult.error) {
        console.error('[validateUserProjectAccess] Error finding organization projects:', orgProjectsResult.error)
        return {
          hasAccess: false,
          accessType: 'none',
          reason: 'Database error while checking organization access'
        }
      }
      
      // Check if user owns any project in the same organization
      // This is a simplified organization membership check
      const userOwnsProjectInOrg = orgProjectsResult.data?.some(
        (orgProject) => orgProject.owner_user_id === userId
      )
      
      if (userOwnsProjectInOrg) {
        const executionTimeMs = Date.now() - startTime
        
        // Log performance metrics
        console.log('[validateUserProjectAccess] Validation completed', {
          userId,
          projectId,
          executionTimeMs,
          meetsRequirement: executionTimeMs < 100,
          accessType: 'organization_member'
        })
        
        return {
          hasAccess: true,
          accessType: 'organization_member',
          organizationId: project.organization_id
        }
      }
    }
    */
    
    const executionTimeMs = Date.now() - startTime
    
    // Log performance metrics for denied access
    console.log('[validateUserProjectAccess] Access denied', {
      userId,
      projectId,
      executionTimeMs,
      meetsRequirement: executionTimeMs < 100
    })
    
    // No access found
    return {
      hasAccess: false,
      accessType: 'none',
      reason: 'User is not owner or organization member'
    }
    
  } catch (error) {
    const executionTimeMs = Date.now() - startTime
    
    console.error('[validateUserProjectAccess] Error validating user project access:', {
      error,
      userId,
      projectId,
      executionTimeMs
    })
    
    return {
      hasAccess: false,
      accessType: 'none',
      reason: 'Unexpected error during access validation'
    }
  }
}

/**
 * Validate user access to project by project reference
 * 
 * @param userId - User ID
 * @param projectRef - Project reference string
 * @returns ProjectAccessResult with access information
 */
export async function validateUserProjectAccessByRef(
  userId: string,
  projectRef: string
): Promise<ProjectAccessResult> {
  try {
    if (!userId || !projectRef) {
      return {
        hasAccess: false,
        accessType: 'none',
        reason: 'Invalid userId or projectRef'
      }
    }

    // Import the project store functions
    const { findByRef } = await import('./self-hosted/project-store-pg')
    
    // Find project by reference
    const projectResult = await findByRef(projectRef)
    
    if (projectResult.error) {
      console.error('Error finding project by ref:', projectResult.error)
      return {
        hasAccess: false,
        accessType: 'none',
        reason: 'Database error while finding project'
      }
    }
    
    if (!projectResult.data) {
      return {
        hasAccess: false,
        accessType: 'none',
        reason: 'Project not found'
      }
    }
    
    // Use the existing validateUserProjectAccess function
    return await validateUserProjectAccess(userId, projectResult.data.id)
    
  } catch (error) {
    console.error('Error validating user project access by ref:', error)
    return {
      hasAccess: false,
      accessType: 'none',
      reason: 'Unexpected error during access validation'
    }
  }
}

/**
 * Get user permissions for a specific project
 * 
 * @param userId - User ID
 * @param projectId - Project ID
 * @returns User permissions object
 */
export async function getUserProjectPermissions(
  userId: string,
  projectId: number
): Promise<{
  canRead: boolean
  canWrite: boolean
  canAdmin: boolean
  canDelete: boolean
  canManageApiKeys: boolean
  canManageJwtKeys: boolean
}> {
  try {
    const accessResult = await validateUserProjectAccess(userId, projectId)
    
    if (!accessResult.hasAccess) {
      return {
        canRead: false,
        canWrite: false,
        canAdmin: false,
        canDelete: false,
        canManageApiKeys: false,
        canManageJwtKeys: false
      }
    }
    
    // Define permissions based on access type
    if (accessResult.accessType === 'owner') {
      // Project owners have full permissions
      return {
        canRead: true,
        canWrite: true,
        canAdmin: true,
        canDelete: true,
        canManageApiKeys: true,
        canManageJwtKeys: true
      }
    } else if (accessResult.accessType === 'organization_member') {
      // Organization members have limited permissions
      return {
        canRead: true,
        canWrite: true,
        canAdmin: false,
        canDelete: false,
        canManageApiKeys: false,
        canManageJwtKeys: false
      }
    }
    
    // Default: no permissions
    return {
      canRead: false,
      canWrite: false,
      canAdmin: false,
      canDelete: false,
      canManageApiKeys: false,
      canManageJwtKeys: false
    }
    
  } catch (error) {
    console.error('Error getting user project permissions:', error)
    return {
      canRead: false,
      canWrite: false,
      canAdmin: false,
      canDelete: false,
      canManageApiKeys: false,
      canManageJwtKeys: false
    }
  }
}

/**
 * Extract user ID from JWT token (helper function)
 * 
 * @param token - JWT token string
 * @param projectRef - Optional project reference for project-specific JWT verification
 * @param requireProjectRef - @deprecated This parameter is no longer used. GoTrue JWT tokens do not contain project_ref claim.
 * @returns User ID or null if invalid
 */
export async function extractUserIdFromToken(
  token: string, 
  projectRef?: string,
  requireProjectRef: boolean = false
): Promise<string | null> {
  try {
    // Use the same verification logic as verifyJwtToken
    // Note: requireProjectRef is ignored as we no longer check project_ref claim
    const decoded = await verifyJwtToken(token, projectRef || undefined, undefined, false)
    
    if (decoded && typeof decoded === 'object' && 'sub' in decoded) {
      return decoded.sub as string
    }
    
    return null
    
  } catch (error) {
    console.error('Error extracting user ID from token:', error)
    return null
  }
}

/**
 * Check if request is from an authenticated user
 * 
 * @param req - Next.js API request object
 * @param projectRef - Optional project reference for project-specific JWT verification
 * @param requireProjectRef - @deprecated This parameter is no longer used. GoTrue JWT tokens do not contain project_ref claim.
 * @returns True if authenticated, false otherwise
 */
export async function isAuthenticated(
  req: NextApiRequest, 
  projectRef?: string,
  requireProjectRef: boolean = false
): Promise<boolean> {
  // Note: requireProjectRef is ignored as we no longer check project_ref claim
  const userId = await getCurrentUserId(req, projectRef, false)
  return userId !== null
}

/**
 * Require authentication for an API endpoint
 * Throws error if user is not authenticated
 * 
 * @param req - Next.js API request object
 * @param projectRef - Optional project reference for project-specific JWT verification
 * @param requireProjectRef - @deprecated This parameter is no longer used. GoTrue JWT tokens do not contain project_ref claim.
 * @returns User ID
 * @throws Error if not authenticated
 */
export async function requireAuthentication(
  req: NextApiRequest, 
  projectRef?: string,
  requireProjectRef: boolean = false
): Promise<string> {
  // Note: requireProjectRef is ignored as we no longer check project_ref claim
  const userId = await getCurrentUserId(req, projectRef, false)
  
  if (!userId) {
    // Log authentication failure for security audit
    const { logAuthenticationFailure, extractErrorContextFromRequest } = await import('./error-handling')
    const resolvedProjectRef = projectRef || extractProjectRefFromRequest(req)
    const context = extractErrorContextFromRequest(req, 'requireAuthentication', { 
      projectRef: resolvedProjectRef || undefined 
    })
    
    logAuthenticationFailure(context, 'Authentication required but no valid token found')
    
    throw new Error('Authentication required')
  }
  
  return userId
}

/**
 * Require authentication and project access for an API endpoint
 * 
 * @param req - Next.js API request object
 * @param projectId - Project ID to check access for
 * @param projectRef - Optional project reference (will be auto-detected if not provided)
 * @returns Object with userId and access information
 * @throws Error if not authenticated or no access
 */
export async function requireProjectAccess(
  req: NextApiRequest,
  projectId: number,
  projectRef?: string
): Promise<{ userId: string; accessResult: ProjectAccessResult }> {
  const resolvedProjectRef = projectRef || extractProjectRefFromRequest(req)
  const userId = await requireAuthentication(req, resolvedProjectRef || undefined)
  const accessResult = await validateUserProjectAccess(userId, projectId)
  
  if (!accessResult.hasAccess) {
    // Log authorization failure for security audit
    const { logAuthorizationFailure, extractErrorContextFromRequest } = await import('./error-handling')
    const context = extractErrorContextFromRequest(req, 'requireProjectAccess', {
      userId,
      projectId,
      projectRef: resolvedProjectRef || undefined
    })
    
    logAuthorizationFailure(context, `Project access denied: ${accessResult.reason}`)
    
    throw new Error(`Access denied: ${accessResult.reason}`)
  }
  
  return { userId, accessResult }
}

/**
 * Require authentication and project access by project reference
 * 
 * @param req - Next.js API request object
 * @param projectRef - Project reference to check access for
 * @returns Object with userId and access information
 * @throws Error if not authenticated or no access
 */
export async function requireProjectAccessByRef(
  req: NextApiRequest,
  projectRef: string
): Promise<{ userId: string; accessResult: ProjectAccessResult }> {
  const userId = await requireAuthentication(req, projectRef)
  const accessResult = await validateUserProjectAccessByRef(userId, projectRef)
  
  if (!accessResult.hasAccess) {
    // Log authorization failure for security audit
    const { logAuthorizationFailure, extractErrorContextFromRequest } = await import('./error-handling')
    const context = extractErrorContextFromRequest(req, 'requireProjectAccessByRef', {
      userId,
      projectRef
    })
    
    logAuthorizationFailure(context, `Project access denied: ${accessResult.reason}`)
    
    throw new Error(`Access denied: ${accessResult.reason}`)
  }
  
  return { userId, accessResult }
}

/**
 * Check if user isolation is enabled in the current environment
 * 
 * @returns True if user isolation is enabled, false otherwise
 */
export function isUserIsolationEnabled(): boolean {
  // Check environment variable to determine if user isolation is enabled
  const userIsolationEnabled = process.env.ENABLE_USER_ISOLATION === 'true'
  
  // In development, we can enable it by default for testing
  const isDevelopment = process.env.NODE_ENV === 'development' || process.env.ENVIRONMENT === 'development'
  
  // Return true if explicitly enabled or in development mode
  return userIsolationEnabled || isDevelopment
}
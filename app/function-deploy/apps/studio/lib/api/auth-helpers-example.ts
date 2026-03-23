/**
 * Example usage of enhanced authentication helpers with project-specific JWT support
 * 
 * This file demonstrates how to use the enhanced authentication system that supports:
 * 1. Global JWT secrets (SUPABASE_JWT_SECRET or JWT_SECRET)
 * 2. Project-specific JWT secrets (JWT_SECRET_[PROJECT_REF] or SUPABASE_JWT_SECRET_[PROJECT_REF])
 * 3. Legacy JWT secrets from project settings
 */

import { NextApiRequest, NextApiResponse } from 'next'
import { 
  getCurrentUserId, 
  requireAuthentication, 
  requireProjectAccessByRef,
  validateJwtTokenWithMultipleSources,
  getProjectLegacyJwtSecret
} from './auth-helpers'

/**
 * Example 1: Basic authentication with automatic project detection
 */
export async function exampleBasicAuth(req: NextApiRequest, res: NextApiResponse) {
  try {
    // This will automatically detect the project reference from the URL
    // and use the appropriate JWT secret (global, project-specific, or legacy)
    const userId = await getCurrentUserId(req)
    
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' })
    }
    
    return res.status(200).json({ userId, message: 'Authenticated successfully' })
  } catch (error) {
    return res.status(500).json({ error: 'Authentication error' })
  }
}

/**
 * Example 2: Project-specific authentication with explicit project reference
 */
export async function exampleProjectAuth(req: NextApiRequest, res: NextApiResponse) {
  const { ref: projectRef } = req.query
  
  if (!projectRef || typeof projectRef !== 'string') {
    return res.status(400).json({ error: 'Project reference required' })
  }
  
  try {
    // Explicitly specify the project reference for JWT verification
    const userId = await getCurrentUserId(req, projectRef)
    
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' })
    }
    
    return res.status(200).json({ 
      userId, 
      projectRef,
      message: 'Authenticated with project-specific JWT' 
    })
  } catch (error) {
    return res.status(500).json({ error: 'Authentication error' })
  }
}

/**
 * Example 3: Full project access validation
 */
export async function exampleProjectAccess(req: NextApiRequest, res: NextApiResponse) {
  const { ref: projectRef } = req.query
  
  if (!projectRef || typeof projectRef !== 'string') {
    return res.status(400).json({ error: 'Project reference required' })
  }
  
  try {
    // This will:
    // 1. Authenticate the user using project-specific JWT if available
    // 2. Validate the user has access to the specified project
    // 3. Return detailed access information
    const { userId, accessResult } = await requireProjectAccessByRef(req, projectRef)
    
    return res.status(200).json({
      userId,
      projectRef,
      accessType: accessResult.accessType,
      organizationId: accessResult.organizationId,
      message: 'Project access validated successfully'
    })
  } catch (error) {
    if (error instanceof Error && error.message.includes('Access denied')) {
      return res.status(403).json({ error: error.message })
    }
    return res.status(500).json({ error: 'Project access validation error' })
  }
}

/**
 * Example 4: Advanced JWT validation with multiple sources
 */
export async function exampleAdvancedJwtValidation(req: NextApiRequest, res: NextApiResponse) {
  const { ref: projectRef } = req.query
  const authHeader = req.headers.authorization
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Bearer token required' })
  }
  
  const token = authHeader.substring(7)
  
  try {
    // This will try multiple JWT secret sources and return detailed information
    const validation = await validateJwtTokenWithMultipleSources(
      token, 
      typeof projectRef === 'string' ? projectRef : undefined
    )
    
    if (!validation.isValid) {
      return res.status(401).json({ error: 'Invalid JWT token' })
    }
    
    return res.status(200).json({
      userId: validation.decoded.sub,
      projectRef: validation.projectRef,
      secretSource: validation.secretSource,
      tokenExpiry: validation.decoded.exp,
      message: `JWT validated using ${validation.secretSource} secret`
    })
  } catch (error) {
    return res.status(500).json({ error: 'JWT validation error' })
  }
}

/**
 * Example 5: Get project legacy JWT secret
 */
export async function exampleGetLegacySecret(req: NextApiRequest, res: NextApiResponse) {
  const { ref: projectRef } = req.query
  
  if (!projectRef || typeof projectRef !== 'string') {
    return res.status(400).json({ error: 'Project reference required' })
  }
  
  try {
    // First authenticate the user
    const userId = await requireAuthentication(req)
    
    // Get the legacy JWT secret for the project
    const legacySecret = await getProjectLegacyJwtSecret(projectRef)
    
    if (!legacySecret) {
      return res.status(404).json({ error: 'Legacy JWT secret not found for project' })
    }
    
    // In a real implementation, you might want to mask the secret or only return metadata
    return res.status(200).json({
      projectRef,
      hasLegacySecret: true,
      secretLength: legacySecret.length,
      message: 'Legacy JWT secret found'
    })
  } catch (error) {
    return res.status(500).json({ error: 'Error retrieving legacy JWT secret' })
  }
}

/**
 * Environment variable setup examples:
 * 
 * Global JWT secret (used for all projects by default):
 * SUPABASE_JWT_SECRET=your-global-jwt-secret
 * 
 * Project-specific JWT secrets:
 * JWT_SECRET_PROJECT1=project1-specific-jwt-secret
 * JWT_SECRET_PROJECT2=project2-specific-jwt-secret
 * SUPABASE_JWT_SECRET_MYPROJECT=myproject-specific-jwt-secret
 * 
 * The system will try secrets in this order:
 * 1. Global secret (SUPABASE_JWT_SECRET or JWT_SECRET)
 * 2. Project-specific secret (JWT_SECRET_[PROJECT_REF] or SUPABASE_JWT_SECRET_[PROJECT_REF])
 * 3. Legacy secret from project settings (retrieved via getProjectLegacyJwtSecret)
 */
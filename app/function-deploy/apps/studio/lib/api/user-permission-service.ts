import { getDatabasePoolManager } from './database-pool-manager'
import { PoolConfig } from 'pg'

/**
 * User Permission Service
 * Handles user authentication and project access validation
 */
export class UserPermissionService {
  private static instance: UserPermissionService
  private permissionCache: Map<string, UserPermissions> = new Map()
  private cacheExpiry: Map<string, number> = new Map()
  private readonly CACHE_TTL = 5 * 60 * 1000 // 5 minutes

  private constructor() {}

  static getInstance(): UserPermissionService {
    if (!UserPermissionService.instance) {
      UserPermissionService.instance = new UserPermissionService()
    }
    return UserPermissionService.instance
  }

  /**
   * Validate user access to a project
   */
  async validateProjectAccess(
    userId: string, 
    projectRef: string, 
    requiredPermissions: ProjectPermissions
  ): Promise<ValidationResult> {
    try {
      // Check cache first
      const cacheKey = `${userId}:${projectRef}`
      const cached = this.getCachedPermissions(cacheKey)
      
      if (cached) {
        return this.checkPermissions(cached, requiredPermissions)
      }

      // Query user permissions from database
      const permissions = await this.queryUserPermissions(userId, projectRef)
      
      if (!permissions) {
        return {
          isValid: false,
          error: 'PROJECT_ACCESS_DENIED',
          message: 'User does not have access to this project'
        }
      }

      // Cache the permissions
      this.cachePermissions(cacheKey, permissions)

      // Check if user has required permissions
      return this.checkPermissions(permissions, requiredPermissions)

    } catch (error) {
      console.error('Permission validation error:', error)
      return {
        isValid: false,
        error: 'PERMISSION_CHECK_FAILED',
        message: 'Failed to validate user permissions'
      }
    }
  }

  /**
   * Query user permissions from database
   */
  private async queryUserPermissions(userId: string, projectRef: string): Promise<UserPermissions | null> {
    const poolManager = getDatabasePoolManager()
    
    // Get SSL configuration - respect POSTGRES_SSL_MODE environment variable
    const globalSSLMode = process.env.POSTGRES_SSL_MODE || process.env.DATABASE_SSL_MODE
    let sslConfig: boolean | object = false
    
    if (globalSSLMode) {
      // Explicitly set SSL mode takes priority
      sslConfig = this.parseSSLMode(globalSSLMode)
      console.log(`[UserPermissionService] Using explicit SSL mode: ${globalSSLMode} -> ${JSON.stringify(sslConfig)}`)
    } else if (process.env.NODE_ENV === 'production') {
      // Only enable SSL in production if not explicitly disabled
      sslConfig = {
        rejectUnauthorized: true,
        ca: require('fs').readFileSync(process.env.RDS_CA_CERT_PATH || '/etc/ssl/certs/rds-global-bundle.pem', 'utf-8'),
      }
      console.log(`[UserPermissionService] Production environment, enabling SSL with rejectUnauthorized: true`)
    } else {
      console.log(`[UserPermissionService] No SSL mode specified, SSL disabled`)
    }
    
    // Global database configuration
    const globalDbConfig: PoolConfig = {
      host: process.env.POSTGRES_HOST || 'db',
      port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
      database: process.env.POSTGRES_DB || 'postgres',
      user: process.env.POSTGRES_USER_READ_WRITE || 'supabase_admin',
      password: process.env.POSTGRES_PASSWORD,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      ssl: sslConfig
    }

    const poolKey = 'global-permissions'

    try {
      console.log(`Querying permissions for user ${userId} on project ${projectRef}`)
      
      // Query project ownership and permissions
      const projectQuery = `
        SELECT 
          sp.id,
          sp.ref,
          sp.name,
          sp.owner_user_id,
          sp.organization_id,
          sp.status,
          CASE 
            WHEN sp.owner_user_id = $1 THEN 'owner'
            ELSE 'none'
          END as role
        FROM studio_projects sp
        WHERE sp.ref = $2 
          AND sp.owner_user_id = $1
        LIMIT 1
      `

      const result = await poolManager.query(
        poolKey,
        globalDbConfig,
        projectQuery,
        [userId, projectRef]
      )

      console.log(`Permission query result for user ${userId} on project ${projectRef}:`, {
        rowCount: result.rows.length,
        rows: result.rows.map((row: any) => ({
          id: row.id,
          ref: row.ref,
          owner_user_id: row.owner_user_id,
          role: row.role,
          status: row.status
        }))
      })

      if (result.rows.length === 0) {
        // Try to find the project without user restriction to see if it exists
        const projectExistsQuery = `
          SELECT id, ref, owner_user_id, status
          FROM studio_projects 
          WHERE ref = $1
          LIMIT 1
        `
        
        const existsResult = await poolManager.query(
          poolKey,
          globalDbConfig,
          projectExistsQuery,
          [projectRef]
        )
        
        if (existsResult.rows.length > 0) {
          const project = existsResult.rows[0]
          console.log(`Project ${projectRef} exists but user ${userId} is not the owner. Project owner: ${project.owner_user_id}`)
        } else {
          console.log(`Project ${projectRef} does not exist in the database`)
        }
        
        return null
      }

      const project = result.rows[0]

      // Determine permissions based on role
      const permissions: UserPermissions = {
        userId,
        projectRef,
        projectId: project.id,
        role: project.role,
        canRead: true, // All users with access can read
        canWrite: project.role === 'owner', // Only owners can write by default
        canAdmin: project.role === 'owner', // Only owners can admin
        canManageDataApi: project.role === 'owner', // Only owners can manage Data API
        organizationId: project.organization_id,
        projectStatus: project.status
      }

      console.log(`Generated permissions for user ${userId} on project ${projectRef}:`, permissions)

      return permissions

    } catch (error) {
      console.error('Failed to query user permissions:', {
        error: error instanceof Error ? error.message : error,
        userId,
        projectRef,
        stack: error instanceof Error ? error.stack : 'No stack trace available'
      })
      return null
    }
  }

  /**
   * Check if user has required permissions
   */
  private checkPermissions(
    userPermissions: UserPermissions, 
    requiredPermissions: ProjectPermissions
  ): ValidationResult {
    // Check if project is active
    if (userPermissions.projectStatus !== 'ACTIVE_HEALTHY') {
      return {
        isValid: false,
        error: 'PROJECT_INACTIVE',
        message: 'Project is not active'
      }
    }

    // Check read permission
    if (requiredPermissions.read && !userPermissions.canRead) {
      return {
        isValid: false,
        error: 'READ_ACCESS_DENIED',
        message: 'User does not have read access to this project'
      }
    }

    // Check write permission
    if (requiredPermissions.write && !userPermissions.canWrite) {
      return {
        isValid: false,
        error: 'WRITE_ACCESS_DENIED',
        message: 'User does not have write access to this project'
      }
    }

    // Check admin permission
    if (requiredPermissions.admin && !userPermissions.canAdmin) {
      return {
        isValid: false,
        error: 'ADMIN_ACCESS_DENIED',
        message: 'User does not have admin access to this project'
      }
    }

    // Check Data API management permission
    if (requiredPermissions.manageDataApi && !userPermissions.canManageDataApi) {
      return {
        isValid: false,
        error: 'DATA_API_MANAGEMENT_DENIED',
        message: 'User does not have Data API management access'
      }
    }

    return {
      isValid: true,
      permissions: userPermissions
    }
  }

  /**
   * Get cached permissions if available and not expired
   */
  private getCachedPermissions(cacheKey: string): UserPermissions | null {
    const cached = this.permissionCache.get(cacheKey)
    const expiry = this.cacheExpiry.get(cacheKey)
    
    if (cached && expiry && Date.now() < expiry) {
      return cached
    }
    
    // Remove expired cache
    if (cached) {
      this.permissionCache.delete(cacheKey)
      this.cacheExpiry.delete(cacheKey)
    }
    
    return null
  }

  /**
   * Cache user permissions
   */
  private cachePermissions(cacheKey: string, permissions: UserPermissions): void {
    this.permissionCache.set(cacheKey, permissions)
    this.cacheExpiry.set(cacheKey, Date.now() + this.CACHE_TTL)
  }

  /**
   * Clear permissions cache for a user
   */
  clearUserCache(userId: string): void {
    const keysToDelete: string[] = []
    
    for (const key of this.permissionCache.keys()) {
      if (key.startsWith(`${userId}:`)) {
        keysToDelete.push(key)
      }
    }
    
    keysToDelete.forEach(key => {
      this.permissionCache.delete(key)
      this.cacheExpiry.delete(key)
    })
  }

  /**
   * Clear permissions cache for a project
   */
  clearProjectCache(projectRef: string): void {
    const keysToDelete: string[] = []
    
    for (const key of this.permissionCache.keys()) {
      if (key.endsWith(`:${projectRef}`)) {
        keysToDelete.push(key)
      }
    }
    
    keysToDelete.forEach(key => {
      this.permissionCache.delete(key)
      this.cacheExpiry.delete(key)
    })
  }

  /**
   * Clear all permissions cache
   */
  clearAllCache(): void {
    this.permissionCache.clear()
    this.cacheExpiry.clear()
  }

  /**
   * Parse SSL mode from string
   */
  private parseSSLMode(sslMode: string): boolean | object {
    const mode = sslMode.toLowerCase()
    
    switch (mode) {
      case 'require':
        return { rejectUnauthorized: true }
      case 'prefer':
        return { rejectUnauthorized: false }
      case 'allow':
        return { rejectUnauthorized: false }
      case 'verify-ca':
        return {
          rejectUnauthorized: true,
          ca: require('fs').readFileSync(process.env.RDS_CA_CERT_PATH || '/etc/ssl/certs/rds-global-bundle.pem', 'utf-8'),
          checkServerIdentity: () => undefined,
        }
      case 'verify-full':
        return {
          rejectUnauthorized: true,
          ca: require('fs').readFileSync(process.env.RDS_CA_CERT_PATH || '/etc/ssl/certs/rds-global-bundle.pem', 'utf-8'),
        }
      case 'disable':
      case 'none':
      case 'false':
        return false
      default:
        console.warn(`[UserPermissionService] Unknown SSL mode: ${sslMode}, defaulting to disabled`)
        return false
    }
  }
}

/**
 * User permissions interface
 */
export interface UserPermissions {
  userId: string
  projectRef: string
  projectId: number
  role: 'owner' | 'admin' | 'member' | 'viewer'
  canRead: boolean
  canWrite: boolean
  canAdmin: boolean
  canManageDataApi: boolean
  organizationId: number
  projectStatus: string
}

/**
 * Required project permissions
 */
export interface ProjectPermissions {
  read?: boolean
  write?: boolean
  admin?: boolean
  manageDataApi?: boolean
}

/**
 * Permission validation result
 */
export interface ValidationResult {
  isValid: boolean
  permissions?: UserPermissions
  error?: string
  message?: string
}

/**
 * Factory function to get the user permission service
 */
export function getUserPermissionService(): UserPermissionService {
  return UserPermissionService.getInstance()
}
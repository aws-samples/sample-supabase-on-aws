import { getDatabasePoolManager } from './database-pool-manager'
import { getUserPermissionService } from './user-permission-service'
import { getSSLErrorHandler } from './ssl-error-handler'
import { SSLConfig, SSLMode, SSLTestResult, ProjectMetadataWithSSL } from './ssl-types'
import { PoolConfig } from 'pg'

/**
 * Project Database Client
 * Handles querying project metadata from the studio_projects table
 */

export interface ProjectMetadata {
  id: number
  ref: string
  name: string
  database_name: string
  database_user: string
  database_password_hash: string
  organization_id: number
  owner_user_id: string
  status: string
  region: string
  connection_string: string
  inserted_at: string
  updated_at: string
}

/**
 * Database client for project metadata operations
 */
export class ProjectDatabaseClient {
  private static instance: ProjectDatabaseClient
  private projectCache: Map<string, ProjectMetadata> = new Map()
  private cacheExpiry: Map<string, number> = new Map()
  private readonly CACHE_TTL = 5 * 60 * 1000 // 5 minutes
  private readonly poolManager = getDatabasePoolManager()
  private readonly permissionService = getUserPermissionService()
  private readonly sslErrorHandler = getSSLErrorHandler()

  private constructor() {}

  static getInstance(): ProjectDatabaseClient {
    if (!ProjectDatabaseClient.instance) {
      ProjectDatabaseClient.instance = new ProjectDatabaseClient()
    }
    return ProjectDatabaseClient.instance
  }

  /**
   * Get project metadata by project reference with user permission validation
   */
  async getProjectByRef(projectRef: string, userId?: string): Promise<ProjectMetadata | null> {
    // Check cache first
    const cached = this.getCachedProject(projectRef)
    if (cached && userId) {
      // Validate user access to cached project
      const validation = await this.permissionService.validateProjectAccess(
        userId, 
        projectRef, 
        { read: true }
      )
      if (!validation.isValid) {
        return null
      }
    }
    if (cached) {
      return cached
    }

    try {
      // Query the database
      const project = await this.queryProjectFromDatabase(projectRef, userId)
      
      if (project) {
        // Cache the result
        this.cacheProject(projectRef, project)
      }
      
      return project
    } catch (error) {
      console.error('Failed to get project metadata:', error)
      return null
    }
  }

  /**
   * Get all projects for a user
   */
  async getProjectsForUser(userId: string): Promise<ProjectMetadata[]> {
    try {
      const globalDbConfig = this.getGlobalDatabaseConfig()
      const poolKey = 'global-projects'

      const query = `
        SELECT 
          sp.id,
          sp.ref,
          sp.name,
          sp.database_name,
          sp.database_user,
          sp.database_password_hash,
          sp.organization_id,
          sp.owner_user_id,
          sp.status,
          sp.region,
          sp.connection_string,
          sp.inserted_at,
          sp.updated_at
        FROM studio_projects sp
        WHERE sp.owner_user_id = $1 
        ORDER BY sp.name ASC
      `

      const result = await this.poolManager.query(
        poolKey,
        globalDbConfig,
        query,
        [userId]
      )

      return result.rows.map(this.mapRowToProjectMetadata)
    } catch (error) {
      console.error('Failed to get projects for user:', error)
      return []
    }
  }

  /**
   * Create a new project
   */
  async createProject(projectData: CreateProjectData, userId: string): Promise<ProjectMetadata | null> {
    try {
      const globalDbConfig = this.getGlobalDatabaseConfig()
      const poolKey = 'global-projects'

      const query = `
        INSERT INTO studio_projects (
          ref, name, database_name, database_user, database_password_hash,
          organization_id, owner_user_id, status, region, connection_string
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING *
      `

      const values = [
        projectData.ref,
        projectData.name,
        projectData.database_name,
        projectData.database_user,
        projectData.database_password_hash,
        projectData.organization_id,
        userId,
        'ACTIVE_HEALTHY',
        projectData.region || 'local',
        projectData.connection_string
      ]

      const result = await this.poolManager.query(
        poolKey,
        globalDbConfig,
        query,
        values
      )

      if (result.rows.length > 0) {
        const project = this.mapRowToProjectMetadata(result.rows[0])
        this.cacheProject(project.ref, project)
        return project
      }

      return null
    } catch (error) {
      console.error('Failed to create project:', error)
      return null
    }
  }

  /**
   * Update project metadata
   */
  async updateProject(projectRef: string, updates: Partial<ProjectMetadata>, userId: string): Promise<ProjectMetadata | null> {
    try {
      // Validate user has admin access
      const validation = await this.permissionService.validateProjectAccess(
        userId, 
        projectRef, 
        { admin: true }
      )
      if (!validation.isValid) {
        throw new Error('User does not have admin access to this project')
      }

      const globalDbConfig = this.getGlobalDatabaseConfig()
      const poolKey = 'global-projects'

      // Build dynamic update query
      const updateFields: string[] = []
      const values: any[] = []
      let paramIndex = 1

      if (updates.name !== undefined) {
        updateFields.push(`name = $${paramIndex++}`)
        values.push(updates.name)
      }
      if (updates.status !== undefined) {
        updateFields.push(`status = $${paramIndex++}`)
        values.push(updates.status)
      }
      if (updates.region !== undefined) {
        updateFields.push(`region = $${paramIndex++}`)
        values.push(updates.region)
      }

      if (updateFields.length === 0) {
        throw new Error('No fields to update')
      }

      updateFields.push(`updated_at = NOW()`)
      values.push(projectRef) // WHERE condition

      const query = `
        UPDATE studio_projects 
        SET ${updateFields.join(', ')}
        WHERE ref = $${paramIndex}
        RETURNING *
      `

      const result = await this.poolManager.query(
        poolKey,
        globalDbConfig,
        query,
        values
      )

      if (result.rows.length > 0) {
        const project = this.mapRowToProjectMetadata(result.rows[0])
        this.cacheProject(project.ref, project)
        return project
      }

      return null
    } catch (error) {
      console.error('Failed to update project:', error)
      return null
    }
  }

  /**
   * Delete a project
   */
  async deleteProject(projectRef: string, userId: string): Promise<boolean> {
    try {
      // Validate user has admin access
      const validation = await this.permissionService.validateProjectAccess(
        userId, 
        projectRef, 
        { admin: true }
      )
      if (!validation.isValid) {
        throw new Error('User does not have admin access to this project')
      }

      const globalDbConfig = this.getGlobalDatabaseConfig()
      const poolKey = 'global-projects'

      const query = `
        DELETE FROM studio_projects 
        WHERE ref = $1 AND owner_user_id = $2
      `

      const result = await this.poolManager.query(
        poolKey,
        globalDbConfig,
        query,
        [projectRef, userId]
      )

      if (result.rowCount > 0) {
        this.clearProjectCache(projectRef)
        return true
      }

      return false
    } catch (error) {
      console.error('Failed to delete project:', error)
      return false
    }
  }

  /**
   * Execute a query on a project's database
   */
  async queryProjectDatabase(
    projectRef: string, 
    userId: string, 
    query: string, 
    params?: any[],
    options?: { skipPermissionCheck?: boolean }
  ): Promise<any> {
    try {
      console.log(`[queryProjectDatabase] Starting query for project ${projectRef}, user ${userId}`)
      
      // Validate user access (unless explicitly skipped)
      if (!options?.skipPermissionCheck) {
        console.log(`[queryProjectDatabase] Validating user access...`)
        const validation = await this.permissionService.validateProjectAccess(
          userId, 
          projectRef, 
          { read: true }
        )
        if (!validation.isValid) {
          console.error(`[queryProjectDatabase] Permission validation failed for user ${userId} on project ${projectRef}:`, validation.error, validation.message)
          throw new Error(`User does not have access to this project: ${validation.message}`)
        }
        console.log(`[queryProjectDatabase] Permission validation passed`)
      } else {
        console.log(`[queryProjectDatabase] Skipping permission check`)
      }

      // Get project metadata (without user validation if permissions already checked)
      console.log(`[queryProjectDatabase] Getting project metadata...`)
      const project = await this.getProjectByRef(projectRef, options?.skipPermissionCheck ? undefined : userId)
      if (!project) {
        console.error(`[queryProjectDatabase] Project not found: ${projectRef}`)
        throw new Error('Project not found')
      }
      
      console.log(`[queryProjectDatabase] Found project: ${project.name} (${project.database_name})`)

      // Create project-specific database configuration
      const projectDbConfig = this.createProjectDatabaseConfig(project)
      const poolKey = `project-${projectRef}`

      console.log(`[queryProjectDatabase] Executing query on project database...`)
      console.log(`[queryProjectDatabase] Pool key: ${poolKey}`)
      console.log(`[queryProjectDatabase] Query: ${query.substring(0, 100)}...`)

      // Execute query on project database
      const result = await this.poolManager.query(
        poolKey,
        projectDbConfig,
        query,
        params
      )

      console.log(`[queryProjectDatabase] Query successful, returned ${result.rows?.length || 0} rows`)
      return result
    } catch (error) {
      console.error(`[queryProjectDatabase] Failed to query project database for ${projectRef}:`, error)
      throw error
    }
  }

  /**
   * Query project from database using real PostgreSQL client
   */
  private async queryProjectFromDatabase(projectRef: string, userId?: string): Promise<ProjectMetadata | null> {
    try {
      const globalDbConfig = this.getGlobalDatabaseConfig()
      const poolKey = 'global-projects'

      console.log(`[queryProjectFromDatabase] Looking up project ${projectRef} for user ${userId}`)
      console.log(`[queryProjectFromDatabase] Global DB config:`, {
        host: globalDbConfig.host,
        port: globalDbConfig.port,
        database: globalDbConfig.database,
        user: globalDbConfig.user,
        ssl: globalDbConfig.ssl,
        application_name: globalDbConfig.application_name
      })

      let query: string
      let params: any[]

      if (userId) {
        // Query with user permission validation
        query = `
          SELECT 
            sp.id,
            sp.ref,
            sp.name,
            sp.database_name,
            sp.database_user,
            sp.database_password_hash,
            sp.organization_id,
            sp.owner_user_id,
            sp.status,
            sp.region,
            sp.connection_string,
            sp.inserted_at,
            sp.updated_at
          FROM studio_projects sp
          WHERE sp.ref = $1 
            AND sp.owner_user_id = $2
          LIMIT 1
        `
        params = [projectRef, userId]
        console.log(`[queryProjectFromDatabase] Query with user validation: ${projectRef}, ${userId}`)
      } else {
        // Query without user validation (for internal use)
        query = `
          SELECT 
            sp.id,
            sp.ref,
            sp.name,
            sp.database_name,
            sp.database_user,
            sp.database_password_hash,
            sp.organization_id,
            sp.owner_user_id,
            sp.status,
            sp.region,
            sp.connection_string,
            sp.inserted_at,
            sp.updated_at
          FROM studio_projects sp
          WHERE sp.ref = $1
          LIMIT 1
        `
        params = [projectRef]
        console.log(`[queryProjectFromDatabase] Query without user validation: ${projectRef}`)
      }

      const result = await this.poolManager.query(
        poolKey,
        globalDbConfig,
        query,
        params
      )

      console.log(`[queryProjectFromDatabase] Query result: ${result.rows.length} rows found`)

      if (result.rows.length === 0) {
        console.log(`[queryProjectFromDatabase] No project found for ref: ${projectRef}`)
        return null
      }

      const project = this.mapRowToProjectMetadata(result.rows[0])
      console.log(`[queryProjectFromDatabase] Found project:`, {
        id: project.id,
        ref: project.ref,
        name: project.name,
        database_name: project.database_name,
        owner_user_id: project.owner_user_id
      })

      return project
    } catch (error) {
      console.error(`[queryProjectFromDatabase] Database query failed for project ${projectRef}:`, error)
      return null
    }
  }

  /**
   * Create project-specific database configuration with enhanced SSL handling
   * Requirements: 10.1, 10.3, 10.4, 12.1, 12.2
   */
  private createProjectDatabaseConfig(project: ProjectMetadata): PoolConfig {
    console.log(`Creating database config for project ${project.ref}:`, {
      hasConnectionString: !!project.connection_string,
      connectionString: project.connection_string ? project.connection_string.replace(/password=[^&]+/, 'password=***') : null
    })

    // First try to use connection_string if available
    if (project.connection_string) {
      try {
        const parsedConfig = this.parseConnectionString(project.connection_string)
        if (parsedConfig) {
          console.log(`Parsed connection string for project ${project.ref}:`, {
            host: parsedConfig.host,
            port: parsedConfig.port,
            database: parsedConfig.database,
            user: parsedConfig.user,
            ssl: parsedConfig.ssl
          })
          return {
            ...parsedConfig,
            max: 10,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 10000,
            application_name: `supabase-studio-${project.ref}`
          }
        }
      } catch (error) {
        console.warn(`Failed to parse connection string for project ${project.ref}, falling back to individual parameters:`, error)
      }
    }

    // Fallback to individual connection parameters
    const sslConfig = this.getProjectSSLConfig(project)
    
    const config = {
      host: this.getProjectHost(project),
      port: this.getProjectPort(project),
      database: project.database_name,
      user: project.database_user,
      password: project.database_password_hash,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      ssl: sslConfig,
      application_name: `supabase-studio-${project.ref}`
    }

    console.log(`Final database config for project ${project.ref}:`, {
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      ssl: config.ssl
    })

    return config
  }

  /**
   * Parse PostgreSQL connection string
   */
  private parseConnectionString(connectionString: string): PoolConfig | null {
    try {
      // Handle different connection string formats
      // postgresql://user:password@host:port/database?options
      // postgres://user:password@host:port/database?options
      
      const url = new URL(connectionString)
      
      if (!['postgresql:', 'postgres:'].includes(url.protocol)) {
        throw new Error('Invalid connection string protocol')
      }

      const config: PoolConfig = {
        host: url.hostname,
        port: url.port ? parseInt(url.port, 10) : 5432,
        database: url.pathname.slice(1), // Remove leading slash
        user: url.username,
        password: url.password
      }

      // Parse SSL and other options from query parameters
      const sslMode = url.searchParams.get('sslmode')
      if (sslMode) {
        config.ssl = this.parseSSLMode(sslMode)
      }

      // Validate required fields
      if (!config.host || !config.database || !config.user) {
        throw new Error('Missing required connection parameters')
      }

      return config
    } catch (error) {
      console.error('Failed to parse connection string:', error)
      return null
    }
  }

  /**
   * Get project-specific host
   */
  private getProjectHost(project: ProjectMetadata): string {
    // Check if project has specific host configuration
    if ((project as any).database_host) {
      return (project as any).database_host
    }
    
    // Fallback to environment variable
    return process.env.POSTGRES_HOST || 'db'
  }

  /**
   * Get project-specific port
   */
  private getProjectPort(project: ProjectMetadata): number {
    // Check if project has specific port configuration
    if ((project as any).database_port) {
      return (project as any).database_port
    }
    
    // Fallback to environment variable
    return parseInt(process.env.POSTGRES_PORT || '5432', 10)
  }

  /**
   * Get project-specific SSL configuration with enhanced validation and logging
   * Requirements: 12.1, 12.2, 12.3, 12.5
   */
  private getProjectSSLConfig(project: ProjectMetadata): boolean | object {
    console.log(`[getProjectSSLConfig] Getting SSL config for project ${project.ref}`)
    
    // Check if project has specific SSL configuration
    if ((project as any).ssl_config) {
      const sslConfig = this.parseProjectSSLConfig((project as any).ssl_config)
      
      // Validate SSL configuration
      const validation = this.sslErrorHandler.validateSSLConfig(sslConfig || false)
      if (!validation.isValid) {
        console.warn(`Invalid SSL configuration for project ${project.ref}:`, validation.errors)
        // Log SSL configuration warning
        console.warn('SSL Configuration Warning:', {
          timestamp: new Date().toISOString(),
          level: 'warning',
          category: 'ssl_config_validation',
          projectRef: project.ref,
          errors: validation.errors,
          warnings: validation.warnings,
          fallbackToDefault: true
        })
      }
      
      console.log(`[getProjectSSLConfig] Using project-specific SSL config: ${JSON.stringify(sslConfig)}`)
      return sslConfig
    }
    
    // Check for SSL configuration in connection string
    if (project.connection_string) {
      const sslFromConnectionString = this.extractSSLFromConnectionString(project.connection_string)
      if (sslFromConnectionString !== null) {
        console.log(`[getProjectSSLConfig] Using SSL config from connection string: ${JSON.stringify(sslFromConnectionString)}`)
        return sslFromConnectionString
      }
    }
    
    // Check environment variable for project-specific SSL override
    const projectSSLOverride = process.env[`PROJECT_${project.ref.toUpperCase()}_SSL_MODE`]
    if (projectSSLOverride) {
      const sslConfig = this.parseSSLMode(projectSSLOverride)
      console.log(`[getProjectSSLConfig] Using project-specific SSL override: ${projectSSLOverride} -> ${JSON.stringify(sslConfig)}`)
      return sslConfig
    }
    
    // Check global SSL configuration
    const globalSSLMode = process.env.POSTGRES_SSL_MODE || process.env.DATABASE_SSL_MODE
    if (globalSSLMode) {
      const sslConfig = this.parseSSLMode(globalSSLMode)
      console.log(`[getProjectSSLConfig] Using global SSL mode: ${globalSSLMode} -> ${JSON.stringify(sslConfig)}`)
      return sslConfig
    }
    
    // Default behavior: SSL is disabled
    // This prevents connection failures when SSL is not supported by the database
    console.log(`[getProjectSSLConfig] No SSL configuration found, defaulting to disabled`)
    return false
  }

  /**
   * Parse SSL mode from connection string with enhanced SSL support and logging
   * Requirements: 12.1, 12.4, 12.5
   */
  private parseSSLMode(sslMode: string): boolean | object {
    const mode = sslMode.toLowerCase()
    
    // Log SSL mode parsing for debugging
    console.log('SSL Mode Parsing:', {
      timestamp: new Date().toISOString(),
      level: 'debug',
      category: 'ssl_mode_parsing',
      inputMode: sslMode,
      normalizedMode: mode
    })
    
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
        console.warn(`Unknown SSL mode: ${sslMode}, defaulting to disabled`)
        // Log SSL mode warning
        console.warn('SSL Mode Warning:', {
          timestamp: new Date().toISOString(),
          level: 'warning',
          category: 'ssl_mode_unknown',
          unknownMode: sslMode,
          fallbackMode: 'disable'
        })
        return false
    }
  }

  /**
   * Parse project-specific SSL configuration object
   * Requirements: 12.2, 12.3
   */
  private parseProjectSSLConfig(sslConfig: any): boolean | object {
    if (typeof sslConfig === 'boolean') {
      return sslConfig
    }
    
    if (typeof sslConfig === 'string') {
      return this.parseSSLMode(sslConfig)
    }
    
    if (typeof sslConfig === 'object' && sslConfig !== null) {
      // Handle SSL configuration object
      const config: any = {}
      
      if ('rejectUnauthorized' in sslConfig) {
        config.rejectUnauthorized = Boolean(sslConfig.rejectUnauthorized)
      }
      
      if ('ca' in sslConfig && sslConfig.ca) {
        config.ca = sslConfig.ca
      }
      
      if ('cert' in sslConfig && sslConfig.cert) {
        config.cert = sslConfig.cert
      }
      
      if ('key' in sslConfig && sslConfig.key) {
        config.key = sslConfig.key
      }
      
      return Object.keys(config).length > 0 ? config : false
    }
    
    return false
  }

  /**
   * Extract SSL configuration from connection string
   * Requirements: 11.2, 12.1
   */
  private extractSSLFromConnectionString(connectionString: string): boolean | object | null {
    try {
      const url = new URL(connectionString)
      const sslMode = url.searchParams.get('sslmode')
      
      if (sslMode) {
        return this.parseSSLMode(sslMode)
      }
      
      // Check for other SSL-related parameters
      const sslCert = url.searchParams.get('sslcert')
      const sslKey = url.searchParams.get('sslkey')
      const sslRootCert = url.searchParams.get('sslrootcert')
      
      if (sslCert || sslKey || sslRootCert) {
        return {
          rejectUnauthorized: true,
          cert: sslCert,
          key: sslKey,
          ca: sslRootCert
        }
      }
      
      return null // No SSL configuration found in connection string
    } catch (error) {
      console.warn('Failed to extract SSL configuration from connection string:', error)
      return null
    }
  }

  /**
   * Test project database connection with enhanced SSL error handling
   * Requirements: 12.4, 12.5
   */
  async testProjectConnection(projectRef: string, userId: string): Promise<SSLTestResult> {
    let connectionAttempt = 0
    const startTime = Date.now()

    try {
      // Validate user access
      const validation = await this.permissionService.validateProjectAccess(
        userId, 
        projectRef, 
        { read: true }
      )
      if (!validation.isValid) {
        console.error(`Permission validation failed for user ${userId} on project ${projectRef}:`, {
          error: validation.error,
          message: validation.message,
          userId,
          projectRef
        })
        return {
          success: false,
          sslEnabled: false,
          error: `User does not have access to this project: ${validation.message}`
        }
      }

      // Get project metadata
      const project = await this.getProjectByRef(projectRef, userId)
      if (!project) {
        console.error(`Project not found: ${projectRef} for user ${userId}`)
        return {
          success: false,
          sslEnabled: false,
          error: 'Project not found'
        }
      }

      console.log(`Testing connection for project ${projectRef}:`, {
        projectId: project.id,
        databaseName: project.database_name,
        databaseUser: project.database_user,
        hasConnectionString: !!project.connection_string,
        ownerUserId: project.owner_user_id,
        requestingUserId: userId,
        ownerMatch: project.owner_user_id === userId
      })

      // Test connection with SSL error handling
      connectionAttempt++
      try {
        const result = await this.queryProjectDatabase(projectRef, userId, 'SELECT 1 as test')
        const connectionTime = Date.now() - startTime
        const projectConfig = this.createProjectDatabaseConfig(project)
        
        return {
          success: true,
          sslEnabled: !!projectConfig.ssl,
          sslMode: this.extractSSLModeFromConfig(projectConfig.ssl),
          connectionTime
        }
      } catch (error) {
        // Check if this is an SSL-related error
        if (this.sslErrorHandler.isSSLError(error)) {
          const sslError = this.sslErrorHandler.categorizeSSLError(error)
          const projectConfig = this.createProjectDatabaseConfig(project)
          const sslMode = this.extractSSLModeFromConfig(projectConfig.ssl)
          
          // Log the SSL error with context
          this.sslErrorHandler.logSSLError(sslError, {
            projectRef,
            sslMode,
            connectionAttempt,
            fallbackAttempted: false
          })

          console.warn(`SSL connection failed for project ${projectRef}, attempting without SSL:`, sslError.message)
          
          // Try to reconnect without SSL
          connectionAttempt++
          const fallbackResult = await this.testConnectionWithoutSSL(project, userId)
          
          if (fallbackResult.success) {
            // Log successful fallback
            this.sslErrorHandler.logSSLError(sslError, {
              projectRef,
              sslMode,
              connectionAttempt,
              fallbackAttempted: true
            })

            return {
              success: true,
              sslEnabled: false,
              connectionTime: Date.now() - startTime,
              fallbackUsed: true,
              error: `SSL connection failed, connected without SSL: ${sslError.message}`
            }
          } else {
            return {
              success: false,
              sslEnabled: !!projectConfig.ssl,
              sslMode,
              connectionTime: Date.now() - startTime,
              error: `Both SSL and non-SSL connections failed: ${sslError.message}`
            }
          }
        }
        
        // Re-throw non-SSL errors
        throw error
      }
    } catch (error) {
      const connectionTime = Date.now() - startTime
      console.error(`Failed to test connection for project ${projectRef}:`, {
        error: error instanceof Error ? error.message : error,
        userId,
        projectRef,
        connectionAttempt,
        connectionTime,
        stack: error instanceof Error ? error.stack : undefined
      })
      
      return {
        success: false,
        sslEnabled: false,
        connectionTime,
        error: error instanceof Error ? error.message : 'Unknown error occurred'
      }
    }
  }

  /**
   * Test connection without SSL as fallback
   * Requirements: 12.4
   */
  private async testConnectionWithoutSSL(project: ProjectMetadata, userId: string): Promise<SSLTestResult> {
    try {
      // Create a temporary configuration without SSL
      const tempConfig = this.createProjectDatabaseConfig(project)
      tempConfig.ssl = false
      
      const poolKey = `project-${project.ref}-no-ssl-test`
      
      // Test with a simple query
      const result = await this.poolManager.query(
        poolKey,
        tempConfig,
        'SELECT 1 as test',
        []
      )
      
      // Clean up the temporary pool
      this.poolManager.closePool(poolKey)
      
      const success = result && result.rows && result.rows.length > 0
      return {
        success,
        sslEnabled: false,
        error: success ? undefined : 'Non-SSL connection test failed'
      }
    } catch (error) {
      console.error(`Non-SSL connection test also failed for project ${project.ref}:`, error)
      return {
        success: false,
        sslEnabled: false,
        error: error instanceof Error ? error.message : 'Non-SSL connection failed'
      }
    }
  }

  /**
   * Extract SSL mode from SSL configuration
   * Requirements: 12.1
   */
  private extractSSLModeFromConfig(sslConfig: boolean | object | undefined): SSLMode | undefined {
    if (sslConfig === undefined || sslConfig === null) {
      return undefined
    }
    
    if (typeof sslConfig === 'boolean') {
      return sslConfig ? 'require' : 'disable'
    }
    
    if (typeof sslConfig === 'object' && sslConfig !== null) {
      // Try to determine mode from configuration
      if ('rejectUnauthorized' in sslConfig) {
        return sslConfig.rejectUnauthorized ? 'verify-ca' : 'require'
      }
      return 'require'
    }
    
    return undefined
  }


  /**
   * Get connection info for debugging (without sensitive data)
   * Requirements: 12.4
   */
  async getProjectConnectionInfo(projectRef: string, userId: string): Promise<any> {
    try {
      // Validate user access
      const validation = await this.permissionService.validateProjectAccess(
        userId, 
        projectRef, 
        { read: true }
      )
      if (!validation.isValid) {
        throw new Error('User does not have access to this project')
      }

      // Get project metadata
      const project = await this.getProjectByRef(projectRef, userId)
      if (!project) {
        throw new Error('Project not found')
      }

      const config = this.createProjectDatabaseConfig(project)
      
      // Return connection info without sensitive data
      return {
        projectRef,
        host: config.host,
        port: config.port,
        database: config.database,
        user: config.user,
        sslEnabled: !!config.ssl,
        sslConfig: this.sanitizeSSLConfig(config.ssl || false),
        poolKey: `project-${projectRef}`,
        hasConnectionString: !!project.connection_string,
        connectionSource: project.connection_string ? 'connection_string' : 'individual_parameters',
        sslSource: this.getSSLConfigSource(project)
      }
    } catch (error) {
      console.error(`Failed to get connection info for project ${projectRef}:`, error)
      throw error
    }
  }

  /**
   * Sanitize SSL configuration for debugging (remove sensitive data)
   * Requirements: 12.4
   */
  private sanitizeSSLConfig(sslConfig: boolean | object): any {
    if (typeof sslConfig === 'boolean') {
      return sslConfig
    }
    
    if (typeof sslConfig === 'object' && sslConfig !== null) {
      const sanitized: any = {}
      
      if ('rejectUnauthorized' in sslConfig) {
        sanitized.rejectUnauthorized = sslConfig.rejectUnauthorized
      }
      
      if ('ca' in sslConfig) {
        sanitized.hasCaCert = !!sslConfig.ca
      }
      
      if ('cert' in sslConfig) {
        sanitized.hasClientCert = !!sslConfig.cert
      }
      
      if ('key' in sslConfig) {
        sanitized.hasClientKey = !!sslConfig.key
      }
      
      return sanitized
    }
    
    return sslConfig
  }

  /**
   * Get the source of SSL configuration for debugging
   * Requirements: 12.1, 12.2
   */
  private getSSLConfigSource(project: ProjectMetadata): string {
    if ((project as any).ssl_config) {
      return 'project_ssl_config'
    }
    
    if (project.connection_string && this.extractSSLFromConnectionString(project.connection_string)) {
      return 'connection_string'
    }
    
    const projectSSLOverride = process.env[`PROJECT_${project.ref.toUpperCase()}_SSL_MODE`]
    if (projectSSLOverride) {
      return 'project_env_override'
    }
    
    const globalSSLMode = process.env.POSTGRES_SSL_MODE || process.env.DATABASE_SSL_MODE
    if (globalSSLMode) {
      return 'global_env_config'
    }
    
    return 'default_disabled'
  }

  /**
   * Get global database configuration for studio metadata
   */
  private getGlobalDatabaseConfig(): PoolConfig {
    // Get SSL configuration using the same logic as project-specific configs
    const globalSSLMode = process.env.POSTGRES_SSL_MODE || process.env.DATABASE_SSL_MODE
    let sslConfig: boolean | object = false
    
    if (globalSSLMode) {
      // Explicitly set SSL mode takes priority
      sslConfig = this.parseSSLMode(globalSSLMode)
      console.log(`[getGlobalDatabaseConfig] Using explicit SSL mode: ${globalSSLMode} -> ${JSON.stringify(sslConfig)}`)
    } else if (process.env.NODE_ENV === 'production') {
      // Only enable SSL in production if not explicitly disabled
      sslConfig = {
        rejectUnauthorized: true,
        ca: require('fs').readFileSync(process.env.RDS_CA_CERT_PATH || '/etc/ssl/certs/rds-global-bundle.pem', 'utf-8'),
      }
      console.log(`[getGlobalDatabaseConfig] Production environment, enabling SSL with rejectUnauthorized: true`)
    } else {
      console.log(`[getGlobalDatabaseConfig] No SSL mode specified, SSL disabled`)
    }
    
    return {
      host: process.env.POSTGRES_HOST || 'db',
      port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
      database: process.env.POSTGRES_DB || 'postgres',
      user: process.env.POSTGRES_USER_READ_WRITE || 'supabase_admin',
      password: process.env.POSTGRES_PASSWORD,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      ssl: sslConfig,
      application_name: 'supabase-studio-global'
    }
  }

  /**
   * Map database row to ProjectMetadata interface
   */
  private mapRowToProjectMetadata(row: any): ProjectMetadata {
    return {
      id: row.id,
      ref: row.ref,
      name: row.name,
      database_name: row.database_name,
      database_user: row.database_user,
      database_password_hash: row.database_password_hash,
      organization_id: row.organization_id,
      owner_user_id: row.owner_user_id,
      status: row.status,
      region: row.region,
      connection_string: row.connection_string,
      inserted_at: row.inserted_at,
      updated_at: row.updated_at
    }
  }

  /**
   * Get cached project if available and not expired
   */
  private getCachedProject(projectRef: string): ProjectMetadata | null {
    const cached = this.projectCache.get(projectRef)
    const expiry = this.cacheExpiry.get(projectRef)
    
    if (cached && expiry && Date.now() < expiry) {
      return cached
    }
    
    // Remove expired cache
    if (cached) {
      this.projectCache.delete(projectRef)
      this.cacheExpiry.delete(projectRef)
    }
    
    return null
  }

  /**
   * Cache project metadata
   */
  private cacheProject(projectRef: string, project: ProjectMetadata): void {
    this.projectCache.set(projectRef, project)
    this.cacheExpiry.set(projectRef, Date.now() + this.CACHE_TTL)
  }

  /**
   * Clear cache for a specific project
   */
  clearProjectCache(projectRef: string): void {
    this.projectCache.delete(projectRef)
    this.cacheExpiry.delete(projectRef)
  }

  /**
   * Clear all cached projects
   */
  clearAllCache(): void {
    this.projectCache.clear()
    this.cacheExpiry.clear()
  }
}

/**
 * Interface for creating new projects
 */
export interface CreateProjectData {
  ref: string
  name: string
  database_name: string
  database_user: string
  database_password_hash: string
  organization_id: number
  region?: string
  connection_string: string
}

/**
 * Factory function to get the project database client
 */
export function getProjectDatabaseClient(): ProjectDatabaseClient {
  return ProjectDatabaseClient.getInstance()
}
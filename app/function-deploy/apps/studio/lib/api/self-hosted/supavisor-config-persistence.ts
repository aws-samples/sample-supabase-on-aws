/**
 * Supavisor Configuration Persistence and Update Manager
 * 
 * This module handles updating Supavisor configuration with validation,
 * rollback capabilities, and environment variable management.
 */

import { promises as fs } from 'fs'
import { join } from 'path'
import { DockerContainerService } from './docker-container-service'
import { SupavisorErrorHandler, type SupavisorError } from './supavisor-error-handler'
import { 
  parseSupavisorEnvironmentVariables,
  type SupavisorEnvironmentConfig,
  type ValidationResult,
  SUPAVISOR_ENV_SCHEMA
} from './supavisor-environment-parser'

export interface ConfigurationUpdateRequest {
  poolSize?: number
  maxClientConnections?: number
  poolMode?: 'session' | 'transaction' | 'statement'
  tenantId?: string
  port?: number
  dbPoolSize?: number
}

export interface ConfigurationBackup {
  timestamp: number
  originalConfig: SupavisorEnvironmentConfig
  originalEnvFile?: string
  backupPath?: string
}

export interface UpdateResult {
  success: boolean
  updatedConfig: SupavisorEnvironmentConfig
  backup: ConfigurationBackup
  validationResult: ValidationResult
  serviceRestarted: boolean
  rollbackAvailable: boolean
}

export class SupavisorConfigPersistence {
  private dockerService: DockerContainerService
  private envFilePath: string
  private backupDir: string

  constructor(envFilePath?: string, backupDir?: string) {
    this.dockerService = new DockerContainerService()
    this.envFilePath = envFilePath || join(process.cwd(), '.env')
    this.backupDir = backupDir || join(process.cwd(), '.env-backups')
  }

  /**
   * Update Supavisor configuration with validation and rollback support
   */
  async updateConfiguration(
    projectRef: string,
    updates: ConfigurationUpdateRequest
  ): Promise<UpdateResult> {
    let backup: ConfigurationBackup | null = null
    let serviceRestarted = false

    try {
      // Step 1: Validate the update request
      this.validateUpdateRequest(updates)

      // Step 2: Get current configuration and create backup
      const { config: currentConfig } = parseSupavisorEnvironmentVariables()
      backup = await this.createConfigurationBackup(currentConfig)

      // Step 3: Apply updates to configuration
      const updatedConfig = this.applyConfigurationUpdates(currentConfig, updates)

      // Step 4: Validate the complete updated configuration
      const validationResult = this.validateUpdatedConfiguration(updatedConfig)
      
      if (!validationResult.isValid) {
        throw SupavisorErrorHandler.createError(
          'configuration-invalid',
          'Updated configuration failed validation',
          undefined,
          { 
            validationErrors: validationResult.errors,
            updates,
            updatedConfig
          }
        )
      }

      // Step 5: Persist configuration to environment file
      await this.persistConfigurationToFile(updatedConfig)

      // Step 6: Restart Supavisor service to apply changes
      try {
        await this.restartSupavisorService()
        serviceRestarted = true

        // Step 7: Verify service started successfully with new configuration
        await this.verifyServiceHealth(projectRef, 30000) // 30 second timeout
      } catch (serviceError) {
        // Service restart failed - attempt rollback
        console.error('Service restart failed, attempting rollback:', serviceError)
        
        try {
          await this.rollbackConfiguration(backup)
          await this.restartSupavisorService()
          
          throw SupavisorErrorHandler.createError(
            'service-unavailable',
            'Configuration update failed and was rolled back due to service startup failure',
            serviceError instanceof Error ? serviceError : undefined,
            { 
              rollbackSuccessful: true,
              originalError: serviceError,
              updates
            }
          )
        } catch (rollbackError) {
          throw SupavisorErrorHandler.createError(
            'service-unavailable',
            'Configuration update failed and rollback also failed - manual intervention required',
            rollbackError instanceof Error ? rollbackError : undefined,
            { 
              rollbackFailed: true,
              originalError: serviceError,
              rollbackError,
              updates,
              backupPath: backup.backupPath
            }
          )
        }
      }

      return {
        success: true,
        updatedConfig,
        backup,
        validationResult,
        serviceRestarted,
        rollbackAvailable: true
      }

    } catch (error) {
      // If we have a backup and something went wrong, ensure rollback is available
      if (backup) {
        return {
          success: false,
          updatedConfig: backup.originalConfig,
          backup,
          validationResult: { isValid: false, errors: [], warnings: [] },
          serviceRestarted,
          rollbackAvailable: true
        }
      }

      throw error
    }
  }

  /**
   * Validate the configuration update request
   */
  private validateUpdateRequest(updates: ConfigurationUpdateRequest): void {
    if (!updates || Object.keys(updates).length === 0) {
      throw SupavisorErrorHandler.createError(
        'configuration-invalid',
        'No configuration updates provided',
        undefined,
        { updates }
      )
    }

    // Validate individual fields
    if (updates.poolSize !== undefined) {
      if (!Number.isInteger(updates.poolSize) || updates.poolSize <= 0) {
        throw SupavisorErrorHandler.createError(
          'configuration-invalid',
          'Pool size must be a positive integer',
          undefined,
          { poolSize: updates.poolSize }
        )
      }
      if (updates.poolSize > 1000) {
        throw SupavisorErrorHandler.createError(
          'configuration-invalid',
          'Pool size cannot exceed 1000 connections',
          undefined,
          { poolSize: updates.poolSize }
        )
      }
    }

    if (updates.maxClientConnections !== undefined) {
      if (!Number.isInteger(updates.maxClientConnections) || updates.maxClientConnections <= 0) {
        throw SupavisorErrorHandler.createError(
          'configuration-invalid',
          'Max client connections must be a positive integer',
          undefined,
          { maxClientConnections: updates.maxClientConnections }
        )
      }
      if (updates.maxClientConnections > 10000) {
        throw SupavisorErrorHandler.createError(
          'configuration-invalid',
          'Max client connections cannot exceed 10000',
          undefined,
          { maxClientConnections: updates.maxClientConnections }
        )
      }
    }

    if (updates.poolMode !== undefined) {
      const validModes = ['session', 'transaction', 'statement']
      if (!validModes.includes(updates.poolMode)) {
        throw SupavisorErrorHandler.createError(
          'configuration-invalid',
          `Pool mode must be one of: ${validModes.join(', ')}`,
          undefined,
          { poolMode: updates.poolMode, validModes }
        )
      }
    }

    if (updates.port !== undefined) {
      if (!Number.isInteger(updates.port) || updates.port < 1 || updates.port > 65535) {
        throw SupavisorErrorHandler.createError(
          'configuration-invalid',
          'Port must be an integer between 1 and 65535',
          undefined,
          { port: updates.port }
        )
      }
    }

    if (updates.dbPoolSize !== undefined) {
      if (!Number.isInteger(updates.dbPoolSize) || updates.dbPoolSize <= 0) {
        throw SupavisorErrorHandler.createError(
          'configuration-invalid',
          'Database pool size must be a positive integer',
          undefined,
          { dbPoolSize: updates.dbPoolSize }
        )
      }
      if (updates.dbPoolSize > 100) {
        throw SupavisorErrorHandler.createError(
          'configuration-invalid',
          'Database pool size cannot exceed 100 connections',
          undefined,
          { dbPoolSize: updates.dbPoolSize }
        )
      }
    }

    if (updates.tenantId !== undefined) {
      if (!updates.tenantId || updates.tenantId.trim().length === 0) {
        throw SupavisorErrorHandler.createError(
          'configuration-invalid',
          'Tenant ID cannot be empty',
          undefined,
          { tenantId: updates.tenantId }
        )
      }
      if (!/^[a-zA-Z0-9_-]+$/.test(updates.tenantId)) {
        throw SupavisorErrorHandler.createError(
          'configuration-invalid',
          'Tenant ID can only contain letters, numbers, hyphens, and underscores',
          undefined,
          { tenantId: updates.tenantId }
        )
      }
      if (updates.tenantId.length > 64) {
        throw SupavisorErrorHandler.createError(
          'configuration-invalid',
          'Tenant ID cannot exceed 64 characters',
          undefined,
          { tenantId: updates.tenantId }
        )
      }
    }
  }

  /**
   * Apply configuration updates to the current configuration
   */
  private applyConfigurationUpdates(
    currentConfig: SupavisorEnvironmentConfig,
    updates: ConfigurationUpdateRequest
  ): SupavisorEnvironmentConfig {
    const updatedConfig: SupavisorEnvironmentConfig = { ...currentConfig }

    if (updates.poolSize !== undefined) {
      updatedConfig.POOLER_DEFAULT_POOL_SIZE = updates.poolSize
    }

    if (updates.maxClientConnections !== undefined) {
      updatedConfig.POOLER_MAX_CLIENT_CONN = updates.maxClientConnections
    }

    if (updates.poolMode !== undefined) {
      updatedConfig.SUPAVISOR_MODE = updates.poolMode
    }

    if (updates.port !== undefined) {
      updatedConfig.POOLER_PROXY_PORT_TRANSACTION = updates.port
    }

    if (updates.dbPoolSize !== undefined) {
      updatedConfig.POOLER_DB_POOL_SIZE = updates.dbPoolSize
    }

    if (updates.tenantId !== undefined) {
      updatedConfig.POOLER_TENANT_ID = updates.tenantId
    }

    return updatedConfig
  }

  /**
   * Validate the complete updated configuration
   */
  private validateUpdatedConfiguration(config: SupavisorEnvironmentConfig): ValidationResult {
    // Use the existing validation from the parser
    const tempEnv = { ...process.env }
    
    // Temporarily set environment variables for validation
    Object.entries(config).forEach(([key, value]) => {
      if (value !== undefined) {
        process.env[key] = String(value)
      }
    })

    try {
      const { validation } = parseSupavisorEnvironmentVariables()
      return validation
    } finally {
      // Restore original environment
      process.env = tempEnv
    }
  }

  /**
   * Create a backup of the current configuration
   */
  private async createConfigurationBackup(config: SupavisorEnvironmentConfig): Promise<ConfigurationBackup> {
    const timestamp = Date.now()
    const backup: ConfigurationBackup = {
      timestamp,
      originalConfig: { ...config }
    }

    try {
      // Ensure backup directory exists
      await fs.mkdir(this.backupDir, { recursive: true })

      // Read current .env file if it exists
      try {
        const envContent = await fs.readFile(this.envFilePath, 'utf-8')
        backup.originalEnvFile = envContent

        // Create backup file
        const backupFileName = `env-backup-${timestamp}.env`
        const backupPath = join(this.backupDir, backupFileName)
        await fs.writeFile(backupPath, envContent, 'utf-8')
        backup.backupPath = backupPath

        console.log(`Configuration backup created: ${backupPath}`)
      } catch (fileError) {
        console.warn('Could not backup .env file:', fileError)
        // Continue without file backup - we still have the config object
      }
    } catch (error) {
      console.warn('Could not create backup directory:', error)
      // Continue without file backup
    }

    return backup
  }

  /**
   * Persist configuration to environment file
   */
  private async persistConfigurationToFile(config: SupavisorEnvironmentConfig): Promise<void> {
    try {
      // Read existing .env file to preserve other variables
      let existingContent = ''
      try {
        existingContent = await fs.readFile(this.envFilePath, 'utf-8')
      } catch (error) {
        console.log('No existing .env file found, creating new one')
      }

      // Parse existing content into lines
      const lines = existingContent.split('\n')
      const updatedLines: string[] = []
      const processedKeys = new Set<string>()

      // Update existing lines or mark them for replacement
      for (const line of lines) {
        const trimmedLine = line.trim()
        
        // Skip empty lines and comments
        if (!trimmedLine || trimmedLine.startsWith('#')) {
          updatedLines.push(line)
          continue
        }

        // Check if this line contains a Supavisor variable
        const equalIndex = trimmedLine.indexOf('=')
        if (equalIndex > 0) {
          const key = trimmedLine.substring(0, equalIndex).trim()
          
          if (key in config) {
            // Update this Supavisor variable
            updatedLines.push(`${key}=${config[key as keyof SupavisorEnvironmentConfig]}`)
            processedKeys.add(key)
          } else {
            // Keep non-Supavisor variables unchanged
            updatedLines.push(line)
          }
        } else {
          // Keep malformed lines unchanged
          updatedLines.push(line)
        }
      }

      // Add any new Supavisor variables that weren't in the original file
      for (const [key, value] of Object.entries(config)) {
        if (!processedKeys.has(key) && value !== undefined) {
          updatedLines.push(`${key}=${value}`)
        }
      }

      // Write updated content back to file
      const updatedContent = updatedLines.join('\n')
      await fs.writeFile(this.envFilePath, updatedContent, 'utf-8')

      console.log('Configuration persisted to .env file')
    } catch (error) {
      throw SupavisorErrorHandler.createError(
        'configuration-invalid',
        'Failed to persist configuration to .env file',
        error instanceof Error ? error : undefined,
        { envFilePath: this.envFilePath, config }
      )
    }
  }

  /**
   * Restart Supavisor service to apply configuration changes
   */
  private async restartSupavisorService(): Promise<void> {
    try {
      console.log('Restarting Supavisor service...')
      
      // Use the restart method from DockerContainerService
      const restartResult = await this.dockerService.restartContainer('supavisor')
      
      if (!restartResult.success) {
        throw new Error(restartResult.message)
      }

      console.log('Supavisor service restarted successfully')

      // Wait for service to be ready
      await new Promise(resolve => setTimeout(resolve, 5000))

    } catch (error) {
      throw SupavisorErrorHandler.createError(
        'service-unavailable',
        'Failed to restart Supavisor service',
        error instanceof Error ? error : undefined,
        { containerName: 'supavisor' }
      )
    }
  }

  /**
   * Verify that the Supavisor service is healthy after configuration update
   */
  private async verifyServiceHealth(projectRef: string, timeoutMs: number = 30000): Promise<void> {
    const startTime = Date.now()
    const checkInterval = 2000 // Check every 2 seconds

    while (Date.now() - startTime < timeoutMs) {
      try {
        const status = await this.dockerService.getContainerStatus('supavisor')
        
        if (status.status === 'running' && status.health === 'healthy') {
          console.log('Supavisor service is healthy after configuration update')
          return
        }

        if (status.status === 'error') {
          throw new Error(`Supavisor container is in error state: ${status.health}`)
        }

        console.log(`Waiting for Supavisor service to be healthy... (status: ${status.status}, health: ${status.health})`)
        
      } catch (error) {
        console.log('Waiting for Supavisor service to start...', error instanceof Error ? error.message : error)
      }

      await new Promise(resolve => setTimeout(resolve, checkInterval))
    }

    throw SupavisorErrorHandler.createError(
      'timeout',
      `Supavisor service did not become healthy within ${timeoutMs}ms after configuration update`,
      undefined,
      { timeoutMs, projectRef }
    )
  }

  /**
   * Rollback configuration to a previous backup
   */
  async rollbackConfiguration(backup: ConfigurationBackup): Promise<void> {
    try {
      console.log(`Rolling back configuration to backup from ${new Date(backup.timestamp).toISOString()}`)

      if (backup.originalEnvFile && backup.backupPath) {
        // Restore from backup file
        await fs.writeFile(this.envFilePath, backup.originalEnvFile, 'utf-8')
        console.log('Configuration rolled back from backup file')
      } else {
        // Restore from config object
        await this.persistConfigurationToFile(backup.originalConfig)
        console.log('Configuration rolled back from backup object')
      }

    } catch (error) {
      throw SupavisorErrorHandler.createError(
        'configuration-invalid',
        'Failed to rollback configuration',
        error instanceof Error ? error : undefined,
        { backup, envFilePath: this.envFilePath }
      )
    }
  }

  /**
   * List available configuration backups
   */
  async listBackups(): Promise<ConfigurationBackup[]> {
    try {
      const backups: ConfigurationBackup[] = []
      
      try {
        const files = await fs.readdir(this.backupDir)
        
        for (const file of files) {
          if (file.startsWith('env-backup-') && file.endsWith('.env')) {
            const timestampMatch = file.match(/env-backup-(\d+)\.env/)
            if (timestampMatch) {
              const timestamp = parseInt(timestampMatch[1])
              const backupPath = join(this.backupDir, file)
              
              try {
                const content = await fs.readFile(backupPath, 'utf-8')
                
                // Parse the backup file to extract configuration
                const config = this.parseEnvFileContent(content)
                
                backups.push({
                  timestamp,
                  originalConfig: config,
                  originalEnvFile: content,
                  backupPath
                })
              } catch (readError) {
                console.warn(`Could not read backup file ${file}:`, readError)
              }
            }
          }
        }
      } catch (dirError) {
        console.log('No backup directory found or could not read it')
      }

      return backups.sort((a, b) => b.timestamp - a.timestamp) // Most recent first
    } catch (error) {
      console.warn('Error listing backups:', error)
      return []
    }
  }

  /**
   * Parse environment file content to extract Supavisor configuration
   */
  private parseEnvFileContent(content: string): SupavisorEnvironmentConfig {
    const config: Partial<SupavisorEnvironmentConfig> = {}
    const lines = content.split('\n')

    for (const line of lines) {
      const trimmedLine = line.trim()
      if (!trimmedLine || trimmedLine.startsWith('#')) continue

      const equalIndex = trimmedLine.indexOf('=')
      if (equalIndex > 0) {
        const key = trimmedLine.substring(0, equalIndex).trim()
        const value = trimmedLine.substring(equalIndex + 1).trim()

        // Only include Supavisor-related variables
        const schema = SUPAVISOR_ENV_SCHEMA.find(s => s.name === key)
        if (schema) {
          if (schema.type === 'number') {
            const numValue = parseFloat(value)
            if (!isNaN(numValue)) {
              (config as any)[key] = numValue
            }
          } else {
            (config as any)[key] = value
          }
        }
      }
    }

    return config as SupavisorEnvironmentConfig
  }

  /**
   * Clean up old backup files (keep only the most recent N backups)
   */
  async cleanupOldBackups(keepCount: number = 10): Promise<void> {
    try {
      const backups = await this.listBackups()
      
      if (backups.length > keepCount) {
        const backupsToDelete = backups.slice(keepCount)
        
        for (const backup of backupsToDelete) {
          if (backup.backupPath) {
            try {
              await fs.unlink(backup.backupPath)
              console.log(`Deleted old backup: ${backup.backupPath}`)
            } catch (deleteError) {
              console.warn(`Could not delete backup ${backup.backupPath}:`, deleteError)
            }
          }
        }
      }
    } catch (error) {
      console.warn('Error cleaning up old backups:', error)
    }
  }
}
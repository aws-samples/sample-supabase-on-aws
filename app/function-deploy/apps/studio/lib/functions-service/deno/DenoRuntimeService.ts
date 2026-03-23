/**
 * Deno Runtime Service for Edge Functions
 * 
 * Provides integration between Edge Functions storage backends and Deno runtime.
 * Handles TypeScript compilation, import resolution, and function execution
 * for both local file system and S3 storage backends.
 */

import * as path from 'path'
import * as fs from 'fs/promises'
import { StorageBackend, FunctionFile, FunctionMetadata } from '../storage/StorageBackend'

/**
 * Deno runtime configuration
 */
export interface DenoRuntimeConfig {
  /** Deno executable path */
  denoPath?: string
  /** Temporary directory for function preparation */
  tempDir?: string
  /** Cache directory for Deno modules */
  cacheDir?: string
  /** Maximum execution timeout in milliseconds */
  executionTimeout?: number
  /** Enable TypeScript type checking */
  typeCheck?: boolean
  /** Deno permissions */
  permissions?: DenoPermissions
}

/**
 * Deno permissions configuration
 */
export interface DenoPermissions {
  /** Allow network access */
  allowNet?: boolean | string[]
  /** Allow file system read access */
  allowRead?: boolean | string[]
  /** Allow file system write access */
  allowWrite?: boolean | string[]
  /** Allow environment variable access */
  allowEnv?: boolean | string[]
  /** Allow subprocess execution */
  allowRun?: boolean | string[]
}

/**
 * Function execution context
 */
export interface FunctionExecutionContext {
  /** Project reference */
  projectRef: string
  /** Function slug */
  functionSlug: string
  /** Function metadata */
  metadata: FunctionMetadata
  /** Function files */
  files: FunctionFile[]
  /** Prepared function directory path */
  functionPath: string
  /** Import map content (if any) */
  importMap?: string
}

/**
 * Function execution result
 */
export interface FunctionExecutionResult {
  /** Exit code */
  exitCode: number
  /** Standard output */
  stdout: string
  /** Standard error */
  stderr: string
  /** Execution time in milliseconds */
  executionTime: number
  /** Whether execution was successful */
  success: boolean
  /** Error message if execution failed */
  error?: string
}

/**
 * Function preparation result
 */
export interface FunctionPreparationResult {
  /** Prepared function directory path */
  functionPath: string
  /** Entry point file path */
  entryPointPath: string
  /** Import map file path (if any) */
  importMapPath?: string
  /** Cleanup function to remove temporary files */
  cleanup: () => Promise<void>
}

/**
 * Deno Runtime Service
 * 
 * Manages Deno runtime integration for Edge Functions with support for
 * both local file system and S3 storage backends.
 */
export class DenoRuntimeService {
  private readonly config: Required<DenoRuntimeConfig>
  private readonly functionCache = new Map<string, FunctionPreparationResult>()

  constructor(config: DenoRuntimeConfig = {}) {
    this.config = {
      denoPath: config.denoPath || 'deno',
      tempDir: config.tempDir || '/tmp/edge-functions',
      cacheDir: config.cacheDir || '/tmp/deno-cache',
      executionTimeout: config.executionTimeout || 30000, // 30 seconds
      typeCheck: config.typeCheck ?? true,
      permissions: config.permissions || {
        allowNet: true,
        allowRead: true,
        allowWrite: false,
        allowEnv: false,
        allowRun: false,
      },
    }
  }

  /**
   * Prepare function for execution from storage backend
   * 
   * @param storageBackend - Storage backend to retrieve function from
   * @param projectRef - Project reference
   * @param functionSlug - Function slug
   * @returns Function preparation result
   */
  async prepareFunction(
    storageBackend: StorageBackend,
    projectRef: string,
    functionSlug: string
  ): Promise<FunctionPreparationResult> {
    const cacheKey = `${storageBackend.getType()}:${projectRef}:${functionSlug}`
    
    // Check if function is already prepared and cached
    const cached = this.functionCache.get(cacheKey)
    if (cached) {
      // Verify the prepared directory still exists
      try {
        await fs.access(cached.functionPath)
        return cached
      } catch {
        // Cache is stale, remove it
        this.functionCache.delete(cacheKey)
      }
    }

    try {
      // Get function metadata and files from storage
      const [metadata, files] = await Promise.all([
        storageBackend.getMetadata(projectRef, functionSlug),
        storageBackend.retrieve(projectRef, functionSlug),
      ])

      if (!metadata) {
        throw new Error(`Function ${functionSlug} not found in project ${projectRef}`)
      }

      // Create temporary directory for this function
      const functionPath = path.join(
        this.config.tempDir,
        storageBackend.getType(),
        projectRef,
        functionSlug,
        Date.now().toString()
      )

      await fs.mkdir(functionPath, { recursive: true })

      // Write all function files to temporary directory
      let importMapPath: string | undefined
      let entryPointPath: string | undefined

      for (const file of files) {
        const filePath = path.join(functionPath, file.path)
        const fileDir = path.dirname(filePath)
        
        // Ensure file directory exists
        await fs.mkdir(fileDir, { recursive: true })
        
        // Write file content
        await fs.writeFile(filePath, file.content, 'utf-8')

        // Track special files
        if (file.name === 'import_map.json' || file.path === 'import_map.json') {
          importMapPath = filePath
        }
        
        if (file.path === metadata.entrypoint || file.name === metadata.entrypoint) {
          entryPointPath = filePath
        }
      }

      // Ensure we found the entry point
      if (!entryPointPath) {
        // Try common entry point names
        const commonEntryPoints = ['index.ts', 'index.js', 'main.ts', 'main.js']
        for (const entryPoint of commonEntryPoints) {
          const testPath = path.join(functionPath, entryPoint)
          try {
            await fs.access(testPath)
            entryPointPath = testPath
            break
          } catch {
            // Continue searching
          }
        }
      }

      if (!entryPointPath) {
        throw new Error(`Entry point file '${metadata.entrypoint}' not found`)
      }

      // Create cleanup function
      const cleanup = async () => {
        try {
          await fs.rm(functionPath, { recursive: true, force: true })
          this.functionCache.delete(cacheKey)
        } catch (error) {
          console.warn(`Failed to cleanup function directory ${functionPath}:`, error)
        }
      }

      const result: FunctionPreparationResult = {
        functionPath,
        entryPointPath,
        importMapPath,
        cleanup,
      }

      // Cache the result
      this.functionCache.set(cacheKey, result)

      return result

    } catch (error: any) {
      throw new Error(`Failed to prepare function for Deno runtime: ${error.message}`)
    }
  }

  /**
   * Execute a function using Deno runtime
   * 
   * @param preparation - Function preparation result
   * @param payload - Function payload (optional)
   * @returns Function execution result
   */
  async executeFunction(
    preparation: FunctionPreparationResult,
    payload?: any
  ): Promise<FunctionExecutionResult> {
    const startTime = Date.now()

    try {
      // Build Deno command arguments
      const args = ['run']

      // Add permissions
      if (this.config.permissions.allowNet) {
        if (Array.isArray(this.config.permissions.allowNet)) {
          args.push(`--allow-net=${this.config.permissions.allowNet.join(',')}`)
        } else {
          args.push('--allow-net')
        }
      }

      if (this.config.permissions.allowRead) {
        if (Array.isArray(this.config.permissions.allowRead)) {
          args.push(`--allow-read=${this.config.permissions.allowRead.join(',')}`)
        } else {
          args.push('--allow-read')
        }
      }

      if (this.config.permissions.allowWrite) {
        if (Array.isArray(this.config.permissions.allowWrite)) {
          args.push(`--allow-write=${this.config.permissions.allowWrite.join(',')}`)
        } else {
          args.push('--allow-write')
        }
      }

      if (this.config.permissions.allowEnv) {
        if (Array.isArray(this.config.permissions.allowEnv)) {
          args.push(`--allow-env=${this.config.permissions.allowEnv.join(',')}`)
        } else {
          args.push('--allow-env')
        }
      }

      if (this.config.permissions.allowRun) {
        if (Array.isArray(this.config.permissions.allowRun)) {
          args.push(`--allow-run=${this.config.permissions.allowRun.join(',')}`)
        } else {
          args.push('--allow-run')
        }
      }

      // Add import map if available
      if (preparation.importMapPath) {
        args.push(`--import-map=${preparation.importMapPath}`)
      }

      // Add cache directory
      args.push(`--cache-dir=${this.config.cacheDir}`)

      // Add type checking option
      if (!this.config.typeCheck) {
        args.push('--no-check')
      }

      // Add entry point
      args.push(preparation.entryPointPath)

      // Execute Deno process
      const { spawn } = await import('child_process')
      
      return new Promise((resolve) => {
        const childProcess = spawn(this.config.denoPath, args, {
          cwd: preparation.functionPath,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            DENO_DIR: this.config.cacheDir,
          },
        })

        let stdout = ''
        let stderr = ''
        let timedOut = false

        // Set up timeout
        const timeout = setTimeout(() => {
          timedOut = true
          childProcess.kill('SIGTERM')
        }, this.config.executionTimeout)

        // Collect output
        childProcess.stdout?.on('data', (data) => {
          stdout += data.toString()
        })

        childProcess.stderr?.on('data', (data) => {
          stderr += data.toString()
        })

        // Send payload if provided
        if (payload !== undefined) {
          try {
            childProcess.stdin?.write(JSON.stringify(payload))
            childProcess.stdin?.end()
          } catch (error) {
            console.warn('Failed to send payload to function:', error)
          }
        } else {
          childProcess.stdin?.end()
        }

        // Handle process completion
        childProcess.on('close', (exitCode) => {
          clearTimeout(timeout)
          
          const executionTime = Date.now() - startTime
          const success = exitCode === 0 && !timedOut

          resolve({
            exitCode: exitCode || (timedOut ? -1 : 1),
            stdout,
            stderr,
            executionTime,
            success,
            error: timedOut 
              ? `Function execution timed out after ${this.config.executionTimeout}ms`
              : success 
                ? undefined 
                : `Function execution failed with exit code ${exitCode}`,
          })
        })

        childProcess.on('error', (error) => {
          clearTimeout(timeout)
          
          resolve({
            exitCode: 1,
            stdout,
            stderr: stderr + error.message,
            executionTime: Date.now() - startTime,
            success: false,
            error: `Failed to execute function: ${error.message}`,
          })
        })
      })

    } catch (error: any) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: error.message,
        executionTime: Date.now() - startTime,
        success: false,
        error: `Failed to execute function: ${error.message}`,
      }
    }
  }

  /**
   * Validate function TypeScript code
   * 
   * @param preparation - Function preparation result
   * @returns Validation result
   */
  async validateFunction(preparation: FunctionPreparationResult): Promise<{
    valid: boolean
    errors: string[]
    warnings: string[]
  }> {
    try {
      // Build Deno check command
      const args = ['check']

      // Add import map if available
      if (preparation.importMapPath) {
        args.push(`--import-map=${preparation.importMapPath}`)
      }

      // Add cache directory
      args.push(`--cache-dir=${this.config.cacheDir}`)

      // Add entry point
      args.push(preparation.entryPointPath)

      // Execute Deno check
      const { spawn } = await import('child_process')
      
      return new Promise((resolve) => {
        const childProcess = spawn(this.config.denoPath, args, {
          cwd: preparation.functionPath,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            DENO_DIR: this.config.cacheDir,
          },
        })

        let stdout = ''
        let stderr = ''

        childProcess.stdout?.on('data', (data) => {
          stdout += data.toString()
        })

        childProcess.stderr?.on('data', (data) => {
          stderr += data.toString()
        })

        childProcess.stdin?.end()

        childProcess.on('close', (exitCode) => {
          const valid = exitCode === 0
          const errors: string[] = []
          const warnings: string[] = []

          // Parse stderr for errors and warnings
          if (stderr) {
            const lines = stderr.split('\n').filter(line => line.trim())
            for (const line of lines) {
              if (line.includes('error:')) {
                errors.push(line)
              } else if (line.includes('warning:')) {
                warnings.push(line)
              }
            }
          }

          resolve({
            valid,
            errors,
            warnings,
          })
        })

        childProcess.on('error', (error) => {
          resolve({
            valid: false,
            errors: [`Failed to validate function: ${error.message}`],
            warnings: [],
          })
        })
      })

    } catch (error: any) {
      return {
        valid: false,
        errors: [`Failed to validate function: ${error.message}`],
        warnings: [],
      }
    }
  }

  /**
   * Preload function dependencies and cache modules
   * 
   * @param preparation - Function preparation result
   * @returns Preload result
   */
  async preloadFunction(preparation: FunctionPreparationResult): Promise<{
    success: boolean
    cachedModules: number
    error?: string
  }> {
    try {
      // Build Deno cache command
      const args = ['cache']

      // Add import map if available
      if (preparation.importMapPath) {
        args.push(`--import-map=${preparation.importMapPath}`)
      }

      // Add cache directory
      args.push(`--cache-dir=${this.config.cacheDir}`)

      // Add entry point
      args.push(preparation.entryPointPath)

      // Execute Deno cache
      const { spawn } = await import('child_process')
      
      return new Promise((resolve) => {
        const childProcess = spawn(this.config.denoPath, args, {
          cwd: preparation.functionPath,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            DENO_DIR: this.config.cacheDir,
          },
        })

        let stdout = ''
        let stderr = ''

        childProcess.stdout?.on('data', (data) => {
          stdout += data.toString()
        })

        childProcess.stderr?.on('data', (data) => {
          stderr += data.toString()
        })

        childProcess.stdin?.end()

        childProcess.on('close', (exitCode) => {
          const success = exitCode === 0
          
          // Count cached modules from output
          const downloadLines = stdout.split('\n').filter(line => 
            line.includes('Download') || line.includes('Check')
          )
          
          resolve({
            success,
            cachedModules: downloadLines.length,
            error: success ? undefined : stderr || 'Unknown preload error',
          })
        })

        childProcess.on('error', (error) => {
          resolve({
            success: false,
            cachedModules: 0,
            error: `Failed to preload function: ${error.message}`,
          })
        })
      })

    } catch (error: any) {
      return {
        success: false,
        cachedModules: 0,
        error: `Failed to preload function: ${error.message}`,
      }
    }
  }

  /**
   * Clear function cache
   * 
   * @param projectRef - Project reference (optional, clears all if not provided)
   * @param functionSlug - Function slug (optional, clears all for project if not provided)
   */
  async clearCache(projectRef?: string, functionSlug?: string): Promise<void> {
    if (!projectRef) {
      // Clear all cached functions
      const cleanupPromises = Array.from(this.functionCache.values()).map(prep => prep.cleanup())
      await Promise.allSettled(cleanupPromises)
      this.functionCache.clear()
      return
    }

    // Clear specific project or function
    const keysToRemove: string[] = []
    const cleanupPromises: Promise<void>[] = []

    for (const [key, preparation] of this.functionCache.entries()) {
      const [, keyProjectRef, keyFunctionSlug] = key.split(':')
      
      if (keyProjectRef === projectRef && (!functionSlug || keyFunctionSlug === functionSlug)) {
        keysToRemove.push(key)
        cleanupPromises.push(preparation.cleanup())
      }
    }

    // Remove from cache and cleanup
    keysToRemove.forEach(key => this.functionCache.delete(key))
    await Promise.allSettled(cleanupPromises)
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): {
    totalCachedFunctions: number
    cacheByStorageType: Record<string, number>
    cacheByProject: Record<string, number>
  } {
    const cacheByStorageType: Record<string, number> = {}
    const cacheByProject: Record<string, number> = {}

    for (const key of this.functionCache.keys()) {
      const [storageType, projectRef] = key.split(':')
      
      cacheByStorageType[storageType] = (cacheByStorageType[storageType] || 0) + 1
      cacheByProject[projectRef] = (cacheByProject[projectRef] || 0) + 1
    }

    return {
      totalCachedFunctions: this.functionCache.size,
      cacheByStorageType,
      cacheByProject,
    }
  }

  /**
   * Health check for Deno runtime
   */
  async healthCheck(): Promise<{
    healthy: boolean
    version?: string
    error?: string
    details?: Record<string, any>
  }> {
    try {
      // Check if Deno is available
      const { spawn } = await import('child_process')
      
      return new Promise((resolve) => {
        const childProcess = spawn(this.config.denoPath, ['--version'], {
          stdio: ['pipe', 'pipe', 'pipe'],
        })

        let stdout = ''
        let stderr = ''

        childProcess.stdout?.on('data', (data) => {
          stdout += data.toString()
        })

        childProcess.stderr?.on('data', (data) => {
          stderr += data.toString()
        })

        childProcess.stdin?.end()

        childProcess.on('close', (exitCode) => {
          if (exitCode === 0) {
            // Extract version from output
            const versionMatch = stdout.match(/deno (\d+\.\d+\.\d+)/)
            const version = versionMatch ? versionMatch[1] : 'unknown'

            resolve({
              healthy: true,
              version,
              details: {
                denoPath: this.config.denoPath,
                cacheDir: this.config.cacheDir,
                tempDir: this.config.tempDir,
              },
            })
          } else {
            resolve({
              healthy: false,
              error: `Deno health check failed with exit code ${exitCode}: ${stderr}`,
              details: {
                denoPath: this.config.denoPath,
                stdout,
                stderr,
              },
            })
          }
        })

        childProcess.on('error', (error) => {
          resolve({
            healthy: false,
            error: `Failed to execute Deno: ${error.message}`,
            details: {
              denoPath: this.config.denoPath,
              originalError: error.message,
            },
          })
        })
      })

    } catch (error: any) {
      return {
        healthy: false,
        error: `Deno health check failed: ${error.message}`,
        details: {
          denoPath: this.config.denoPath,
          originalError: error.message,
        },
      }
    }
  }
}

/**
 * Singleton instance
 */
let denoRuntimeService: DenoRuntimeService | null = null

/**
 * Get the singleton DenoRuntimeService instance
 */
export function getDenoRuntimeService(config?: DenoRuntimeConfig): DenoRuntimeService {
  if (!denoRuntimeService) {
    denoRuntimeService = new DenoRuntimeService(config)
  }
  return denoRuntimeService
}

/**
 * Reset the singleton instance (useful for testing)
 */
export function resetDenoRuntimeService(): void {
  denoRuntimeService = null
}
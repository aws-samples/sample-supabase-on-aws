import * as fs from 'fs/promises'
import * as path from 'path'
import {
  StorageBackend,
  FunctionFile,
  FunctionMetadata,
  StorageHealthStatus,
  StorageBackendError,
  StorageNotFoundError,
  StorageAccessError,
} from './StorageBackend'

/**
 * Local File System Storage Backend
 * 
 * Implements storage backend using the local file system.
 * This is the default storage backend for Edge Functions.
 */
export class LocalFileSystemStorage implements StorageBackend {
  private readonly basePath: string

  constructor(basePath?: string) {
    // Use environment variable or default path
    this.basePath = basePath || process.env.EDGE_FUNCTIONS_LOCAL_PATH || '/home/deno/functions'
  }

  /**
   * Get the storage backend type
   */
  getType(): string {
    return 'local'
  }

  /**
   * Get the project directory path
   */
  private getProjectPath(projectRef: string): string {
    return path.join(this.basePath, projectRef)
  }

  /**
   * Get the function directory path
   */
  private getFunctionPath(projectRef: string, functionSlug: string): string {
    return path.join(this.getProjectPath(projectRef), functionSlug)
  }

  /**
   * Get the metadata file path
   */
  private getMetadataPath(projectRef: string, functionSlug: string): string {
    return path.join(this.getFunctionPath(projectRef, functionSlug), 'metadata.json')
  }

  /**
   * Ensure directory exists
   */
  private async ensureDirectory(dirPath: string): Promise<void> {
    try {
      await fs.mkdir(dirPath, { recursive: true })
    } catch (error: any) {
      if (error.code !== 'EEXIST') {
        throw new StorageAccessError(`Failed to create directory: ${error.message}`, {
          path: dirPath,
          originalError: error,
        })
      }
    }
  }

  /**
   * Store function files and metadata
   */
  async store(
    projectRef: string,
    functionSlug: string,
    files: FunctionFile[],
    metadata: FunctionMetadata
  ): Promise<void> {
    try {
      const functionPath = this.getFunctionPath(projectRef, functionSlug)
      
      // Ensure function directory exists
      await this.ensureDirectory(functionPath)

      // Store all function files
      for (const file of files) {
        const filePath = path.join(functionPath, file.path)
        const fileDir = path.dirname(filePath)
        
        // Ensure file directory exists
        await this.ensureDirectory(fileDir)
        
        // Write file content
        await fs.writeFile(filePath, file.content, 'utf-8')
      }

      // Store metadata
      const metadataPath = this.getMetadataPath(projectRef, functionSlug)
      await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8')

    } catch (error: any) {
      if (error instanceof StorageBackendError) {
        throw error
      }
      throw new StorageAccessError(`Failed to store function: ${error.message}`, {
        projectRef,
        functionSlug,
        originalError: error,
      })
    }
  }

  /**
   * Retrieve function files
   */
  async retrieve(projectRef: string, functionSlug: string): Promise<FunctionFile[]> {
    try {
      const functionPath = this.getFunctionPath(projectRef, functionSlug)
      
      // Check if function exists
      if (!(await this.exists(projectRef, functionSlug))) {
        throw new StorageNotFoundError(`Function ${functionSlug} in project ${projectRef}`)
      }

      const files: FunctionFile[] = []
      
      // Recursively read all files in the function directory
      await this.readDirectoryRecursive(functionPath, functionPath, files)
      
      // Filter out metadata.json as it's not part of the function files
      return files.filter(file => file.name !== 'metadata.json')

    } catch (error: any) {
      if (error instanceof StorageBackendError) {
        throw error
      }
      throw new StorageAccessError(`Failed to retrieve function: ${error.message}`, {
        projectRef,
        functionSlug,
        originalError: error,
      })
    }
  }

  /**
   * Recursively read directory and collect files
   */
  private async readDirectoryRecursive(
    dirPath: string,
    basePath: string,
    files: FunctionFile[]
  ): Promise<void> {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true })
      
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name)
        const relativePath = path.relative(basePath, fullPath)
        
        if (entry.isDirectory()) {
          // Recursively read subdirectory
          await this.readDirectoryRecursive(fullPath, basePath, files)
        } else if (entry.isFile()) {
          // Read file content
          const content = await fs.readFile(fullPath, 'utf-8')
          files.push({
            name: entry.name,
            content,
            path: relativePath,
          })
        }
      }
    } catch (error: any) {
      throw new StorageAccessError(`Failed to read directory: ${error.message}`, {
        dirPath,
        originalError: error,
      })
    }
  }

  /**
   * List all functions in a project
   */
  async list(projectRef: string): Promise<FunctionMetadata[]> {
    try {
      const projectPath = this.getProjectPath(projectRef)
      
      // Check if project directory exists
      try {
        await fs.access(projectPath)
      } catch {
        // Project directory doesn't exist, return empty array
        return []
      }

      const entries = await fs.readdir(projectPath, { withFileTypes: true })
      const functions: FunctionMetadata[] = []

      for (const entry of entries) {
        if (entry.isDirectory()) {
          try {
            let metadata = await this.getMetadata(projectRef, entry.name)
            
            // If no metadata exists, try to generate it from existing files
            if (!metadata) {
              const functionPath = this.getFunctionPath(projectRef, entry.name)
              
              // Check if there are any TypeScript/JavaScript files in the directory
              const functionFiles = await fs.readdir(functionPath)
              const hasCodeFiles = functionFiles.some(file => 
                file.endsWith('.ts') || file.endsWith('.js') || file.endsWith('.tsx') || file.endsWith('.jsx')
              )
              
              if (hasCodeFiles) {
                // Generate default metadata for existing function
                const stats = await fs.stat(functionPath)
                const entrypoint = functionFiles.find(file => 
                  file === 'index.ts' || file === 'index.js' || file === 'mod.ts'
                ) || functionFiles.find(file => 
                  file.endsWith('.ts') || file.endsWith('.js')
                ) || 'index.ts'
                
                metadata = {
                  slug: entry.name,
                  name: entry.name.charAt(0).toUpperCase() + entry.name.slice(1), // Capitalize first letter
                  description: `Auto-generated metadata for ${entry.name} function`,
                  version: '1.0.0',
                  runtime: 'deno' as const,
                  entrypoint,
                  createdAt: stats.birthtime || stats.mtime,
                  updatedAt: stats.mtime,
                  projectRef,
                  userId: 'system', // Default user for auto-generated functions
                }
                
                // Save the generated metadata for future use
                try {
                  await this.storeMetadata(projectRef, entry.name, metadata)
                  console.log(`Generated metadata for existing function: ${entry.name}`)
                } catch (error) {
                  console.warn(`Failed to save generated metadata for ${entry.name}:`, error)
                  // Continue without saving metadata
                }
              }
            }
            
            if (metadata) {
              functions.push(metadata)
            }
          } catch (error) {
            // Skip functions with invalid metadata
            console.warn(`Skipping function ${entry.name} due to invalid metadata:`, error)
          }
        }
      }

      // Sort by name for consistent ordering
      return functions.sort((a, b) => a.name.localeCompare(b.name))

    } catch (error: any) {
      throw new StorageAccessError(`Failed to list functions: ${error.message}`, {
        projectRef,
        originalError: error,
      })
    }
  }

  /**
   * Delete a function and all its files
   */
  async delete(projectRef: string, functionSlug: string): Promise<void> {
    try {
      const functionPath = this.getFunctionPath(projectRef, functionSlug)
      
      // Check if function exists
      if (!(await this.exists(projectRef, functionSlug))) {
        throw new StorageNotFoundError(`Function ${functionSlug} in project ${projectRef}`)
      }

      // Remove the entire function directory
      await fs.rm(functionPath, { recursive: true, force: true })

    } catch (error: any) {
      if (error instanceof StorageBackendError) {
        throw error
      }
      throw new StorageAccessError(`Failed to delete function: ${error.message}`, {
        projectRef,
        functionSlug,
        originalError: error,
      })
    }
  }

  /**
   * Store metadata for a function
   */
  private async storeMetadata(projectRef: string, functionSlug: string, metadata: FunctionMetadata): Promise<void> {
    try {
      const metadataPath = this.getMetadataPath(projectRef, functionSlug)
      await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8')
    } catch (error: any) {
      throw new StorageAccessError(`Failed to store metadata: ${error.message}`, {
        projectRef,
        functionSlug,
        originalError: error,
      })
    }
  }

  /**
   * Get function metadata
   */
  async getMetadata(projectRef: string, functionSlug: string): Promise<FunctionMetadata | null> {
    try {
      const metadataPath = this.getMetadataPath(projectRef, functionSlug)
      
      try {
        const content = await fs.readFile(metadataPath, 'utf-8')
        const metadata = JSON.parse(content) as FunctionMetadata
        
        // Convert date strings back to Date objects
        return {
          ...metadata,
          createdAt: new Date(metadata.createdAt),
          updatedAt: new Date(metadata.updatedAt),
        }
      } catch (error: any) {
        if (error.code === 'ENOENT') {
          return null
        }
        throw error
      }

    } catch (error: any) {
      if (error instanceof StorageBackendError) {
        throw error
      }
      throw new StorageAccessError(`Failed to get metadata: ${error.message}`, {
        projectRef,
        functionSlug,
        originalError: error,
      })
    }
  }

  /**
   * Check if a function exists
   */
  async exists(projectRef: string, functionSlug: string): Promise<boolean> {
    try {
      const functionPath = this.getFunctionPath(projectRef, functionSlug)
      await fs.access(functionPath)
      return true
    } catch {
      return false
    }
  }

  /**
   * Perform health check on the storage backend
   */
  async healthCheck(): Promise<StorageHealthStatus> {
    try {
      // Check if base path exists and is writable
      await this.ensureDirectory(this.basePath)
      
      // Try to write a test file
      const testPath = path.join(this.basePath, '.health-check')
      const testContent = `Health check at ${new Date().toISOString()}`
      
      await fs.writeFile(testPath, testContent, 'utf-8')
      
      // Try to read it back
      const readContent = await fs.readFile(testPath, 'utf-8')
      
      // Clean up test file
      await fs.unlink(testPath)
      
      if (readContent !== testContent) {
        return {
          healthy: false,
          error: 'File system read/write test failed',
          details: { basePath: this.basePath },
        }
      }

      return {
        healthy: true,
        details: {
          basePath: this.basePath,
          type: 'local',
        },
      }

    } catch (error: any) {
      return {
        healthy: false,
        error: `Local file system health check failed: ${error.message}`,
        details: {
          basePath: this.basePath,
          originalError: error.message,
        },
      }
    }
  }
}
/**
 * Storage Backend Interface for Edge Functions
 * 
 * Provides a unified interface for storing and retrieving Edge Functions
 * across different storage backends (local file system, AWS S3, etc.)
 */

/**
 * Represents a single function file
 */
export interface FunctionFile {
  /** File name (e.g., 'index.ts', 'import_map.json') */
  name: string
  /** File content as string */
  content: string
  /** Relative path within the function directory */
  path: string
}

/**
 * Function metadata for storage operations
 */
export interface FunctionMetadata {
  /** Function slug/identifier */
  slug: string
  /** Display name */
  name: string
  /** Function version */
  version: string
  /** Creation timestamp */
  createdAt: Date
  /** Last update timestamp */
  updatedAt: Date
  /** Project reference */
  projectRef: string
  /** User ID who created the function */
  userId: string
  /** Function description */
  description?: string
  /** Runtime type */
  runtime: 'deno'
  /** Entry point file */
  entrypoint: string
  /** Import map file name */
  importMap?: string
  /** Static file patterns */
  staticPatterns?: string[]
}

/**
 * Storage backend health status
 */
export interface StorageHealthStatus {
  /** Whether the storage backend is healthy */
  healthy: boolean
  /** Error message if unhealthy */
  error?: string
  /** Additional diagnostic information */
  details?: Record<string, any>
}

/**
 * Storage backend interface
 * 
 * All storage backends must implement this interface to provide
 * consistent storage operations for Edge Functions.
 */
export interface StorageBackend {
  /**
   * Store function files and metadata
   * 
   * @param projectRef - Project reference
   * @param functionSlug - Function identifier
   * @param files - Array of function files to store
   * @param metadata - Function metadata
   */
  store(
    projectRef: string,
    functionSlug: string,
    files: FunctionFile[],
    metadata: FunctionMetadata
  ): Promise<void>

  /**
   * Retrieve function files
   * 
   * @param projectRef - Project reference
   * @param functionSlug - Function identifier
   * @returns Array of function files
   */
  retrieve(projectRef: string, functionSlug: string): Promise<FunctionFile[]>

  /**
   * List all functions in a project
   * 
   * @param projectRef - Project reference
   * @returns Array of function metadata
   */
  list(projectRef: string): Promise<FunctionMetadata[]>

  /**
   * Delete a function and all its files
   * 
   * @param projectRef - Project reference
   * @param functionSlug - Function identifier
   */
  delete(projectRef: string, functionSlug: string): Promise<void>

  /**
   * Get function metadata
   * 
   * @param projectRef - Project reference
   * @param functionSlug - Function identifier
   * @returns Function metadata or null if not found
   */
  getMetadata(projectRef: string, functionSlug: string): Promise<FunctionMetadata | null>

  /**
   * Check if a function exists
   * 
   * @param projectRef - Project reference
   * @param functionSlug - Function identifier
   * @returns True if function exists
   */
  exists(projectRef: string, functionSlug: string): Promise<boolean>

  /**
   * Perform health check on the storage backend
   * 
   * @returns Health status
   */
  healthCheck(): Promise<StorageHealthStatus>

  /**
   * Get the storage backend type identifier
   * 
   * @returns Storage backend type
   */
  getType(): string
}

/**
 * Storage backend configuration
 */
export interface StorageBackendConfig {
  /** Storage backend type */
  type: 'local' | 's3'
  /** Configuration options specific to the backend */
  options: Record<string, any>
}

/**
 * Storage backend error types
 */
export class StorageBackendError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: any
  ) {
    super(message)
    this.name = 'StorageBackendError'
  }
}

export class StorageNotFoundError extends StorageBackendError {
  constructor(resource: string, details?: any) {
    super(`Resource not found: ${resource}`, 'STORAGE_NOT_FOUND', details)
    this.name = 'StorageNotFoundError'
  }
}

export class StorageAccessError extends StorageBackendError {
  constructor(message: string, details?: any) {
    super(message, 'STORAGE_ACCESS_ERROR', details)
    this.name = 'StorageAccessError'
  }
}

export class StorageConfigurationError extends StorageBackendError {
  constructor(message: string, details?: any) {
    super(message, 'STORAGE_CONFIGURATION_ERROR', details)
    this.name = 'StorageConfigurationError'
  }
}
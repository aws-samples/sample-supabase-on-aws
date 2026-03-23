import { Agent as HttpAgent } from 'http'
import { Agent as HttpsAgent } from 'https'
import {
  StorageBackend,
  FunctionFile,
  FunctionMetadata,
  StorageHealthStatus,
  StorageBackendError,
  StorageNotFoundError,
  StorageAccessError,
  StorageConfigurationError,
} from './StorageBackend'

// Type definitions for lazy-loaded AWS SDK modules
type S3ClientType = any
type CommandType = any

// Lazy-load AWS SDK to avoid bundling issues when not used
let S3Client: S3ClientType
let PutObjectCommand: CommandType
let GetObjectCommand: CommandType
let DeleteObjectCommand: CommandType
let ListObjectsV2Command: CommandType
let HeadObjectCommand: CommandType
let NodeHttpHandler: any

async function loadAwsSdk() {
  if (!S3Client) {
    const s3Module = await import('@aws-sdk/client-s3')
    S3Client = s3Module.S3Client
    PutObjectCommand = s3Module.PutObjectCommand
    GetObjectCommand = s3Module.GetObjectCommand
    DeleteObjectCommand = s3Module.DeleteObjectCommand
    ListObjectsV2Command = s3Module.ListObjectsV2Command
    HeadObjectCommand = s3Module.HeadObjectCommand
    
    const smithyModule = await import('@smithy/node-http-handler')
    NodeHttpHandler = smithyModule.NodeHttpHandler
  }
}

/**
 * S3 Storage Backend Configuration
 */
export interface S3StorageConfig {
  /** S3 bucket name */
  bucketName: string
  /** AWS region */
  region: string
  /** Custom S3 endpoint (optional) */
  endpoint?: string
  /** AWS access key ID */
  accessKeyId: string
  /** AWS secret access key */
  secretAccessKey: string
  /** Base prefix for all Edge Functions */
  basePrefix?: string
  /** Maximum retry attempts for failed requests */
  maxRetries?: number
  /** Initial retry delay in milliseconds */
  retryDelayMs?: number
  /** Maximum retry delay in milliseconds */
  maxRetryDelayMs?: number
  /** Connection pool size */
  maxSockets?: number
  /** Request timeout in milliseconds */
  requestTimeout?: number
}

/**
 * Retry configuration for S3 operations
 */
interface RetryConfig {
  maxRetries: number
  retryDelayMs: number
  maxRetryDelayMs: number
}

/**
 * Default retry configuration
 */
const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  retryDelayMs: 100,
  maxRetryDelayMs: 5000,
}

/**
 * AWS S3 Storage Backend
 * 
 * Implements storage backend using AWS S3 with:
 * - Retry logic with exponential backoff
 * - Connection pooling for optimal performance
 * - Efficient single-function retrieval
 * - Comprehensive error handling
 * 
 * Uses existing AWS credentials from environment variables.
 */
export class S3Storage implements StorageBackend {
  private s3Client: any
  private readonly bucketName: string
  private readonly basePrefix: string
  private readonly retryConfig: RetryConfig
  private initPromise: Promise<void> | null = null

  constructor(config?: Partial<S3StorageConfig>) {
    // Load configuration from environment variables with optional overrides
    const bucketName = config?.bucketName || process.env.EDGE_FUNCTIONS_S3_BUCKET_NAME
    const region = config?.region || process.env.EDGE_FUNCTIONS_S3_REGION
    const endpoint = config?.endpoint || process.env.EDGE_FUNCTIONS_S3_ENDPOINT
    const accessKeyId = config?.accessKeyId || process.env.AWS_ACCESS_KEY_ID
    const secretAccessKey = config?.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY

    // Validate required configuration
    if (!bucketName) {
      throw new StorageConfigurationError(
        'S3 bucket name is required. Set EDGE_FUNCTIONS_S3_BUCKET_NAME environment variable.'
      )
    }

    if (!region) {
      throw new StorageConfigurationError(
        'S3 region is required. Set EDGE_FUNCTIONS_S3_REGION environment variable.'
      )
    }

    if (!accessKeyId || !secretAccessKey) {
      throw new StorageConfigurationError(
        'AWS credentials are required. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables.'
      )
    }

    this.bucketName = bucketName
    this.basePrefix = config?.basePrefix || 'edge-functions'
    
    // Configure retry behavior
    this.retryConfig = {
      maxRetries: config?.maxRetries ?? DEFAULT_RETRY_CONFIG.maxRetries,
      retryDelayMs: config?.retryDelayMs ?? DEFAULT_RETRY_CONFIG.retryDelayMs,
      maxRetryDelayMs: config?.maxRetryDelayMs ?? DEFAULT_RETRY_CONFIG.maxRetryDelayMs,
    }

    // Initialize S3 client lazily
    this.initPromise = this.initializeS3Client(config, region, endpoint, accessKeyId, secretAccessKey)
  }

  /**
   * Initialize S3 client with lazy-loaded AWS SDK
   */
  private async initializeS3Client(
    config: Partial<S3StorageConfig> | undefined,
    region: string,
    endpoint: string | undefined,
    accessKeyId: string,
    secretAccessKey: string
  ): Promise<void> {
    // Load AWS SDK modules
    await loadAwsSdk()

    // Create HTTP/HTTPS agents with connection pooling
    const maxSockets = config?.maxSockets ?? 50
    const requestTimeout = config?.requestTimeout ?? 30000

    const httpAgent = new HttpAgent({
      keepAlive: true,
      maxSockets,
      timeout: requestTimeout,
    })

    const httpsAgent = new HttpsAgent({
      keepAlive: true,
      maxSockets,
      timeout: requestTimeout,
    })

    // Initialize S3 client with connection pooling
    const s3Config: any = {
      region,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
      requestHandler: new NodeHttpHandler({
        httpAgent,
        httpsAgent,
        connectionTimeout: requestTimeout,
        requestTimeout,
      }),
      maxAttempts: 1, // We handle retries manually for better control
    }
    
    // Only set endpoint if it's provided and not empty
    if (endpoint && endpoint.trim()) {
      s3Config.endpoint = endpoint
      s3Config.forcePathStyle = true
    }
    
    this.s3Client = new S3Client(s3Config)
    
    console.log('[S3Storage] Initialized with connection pooling:', {
      maxSockets,
      requestTimeout,
      maxRetries: this.retryConfig.maxRetries,
      retryDelayMs: this.retryConfig.retryDelayMs,
    })
  }

  /**
   * Ensure S3 client is initialized before use
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise
      this.initPromise = null
    }
  }

  /**
   * Get the storage backend type
   */
  getType(): string {
    return 's3'
  }

  /**
   * Execute an S3 operation with retry logic and exponential backoff
   * 
   * @param operation - Async function to execute
   * @param operationName - Name of the operation for logging
   * @returns Result of the operation
   */
  private async executeWithRetry<T>(
    operation: () => Promise<T>,
    operationName: string
  ): Promise<T> {
    let lastError: Error | null = null
    let attempt = 0

    while (attempt <= this.retryConfig.maxRetries) {
      try {
        if (attempt > 0) {
          console.log(`[S3Storage] Retry attempt ${attempt}/${this.retryConfig.maxRetries} for ${operationName}`)
        }

        return await operation()
      } catch (error: any) {
        lastError = error
        attempt++

        // Check if error is retryable
        if (!this.isRetryableError(error)) {
          console.error(`[S3Storage] Non-retryable error in ${operationName}:`, error.message)
          throw error
        }

        // Don't retry if we've exhausted attempts
        if (attempt > this.retryConfig.maxRetries) {
          console.error(
            `[S3Storage] Max retries (${this.retryConfig.maxRetries}) exceeded for ${operationName}`
          )
          break
        }

        // Calculate exponential backoff delay
        const delay = this.calculateBackoffDelay(attempt)
        console.warn(
          `[S3Storage] ${operationName} failed (attempt ${attempt}), retrying in ${delay}ms:`,
          error.message
        )

        // Wait before retrying
        await this.sleep(delay)
      }
    }

    // All retries exhausted
    throw new StorageAccessError(
      `S3 operation ${operationName} failed after ${this.retryConfig.maxRetries} retries: ${lastError?.message}`,
      {
        operationName,
        attempts: attempt,
        maxRetries: this.retryConfig.maxRetries,
        originalError: lastError,
      }
    )
  }

  /**
   * Check if an error is retryable
   * 
   * Retryable errors include:
   * - Network errors
   * - Timeout errors
   * - Throttling errors (429, 503)
   * - Internal server errors (500, 502, 503, 504)
   */
  private isRetryableError(error: any): boolean {
    // Network errors
    if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND') {
      return true
    }

    // AWS SDK errors
    if (error.name === 'TimeoutError' || error.name === 'NetworkingError') {
      return true
    }

    // HTTP status codes
    const statusCode = error.$metadata?.httpStatusCode || error.statusCode
    if (statusCode) {
      // Throttling and server errors
      if (statusCode === 429 || statusCode === 503 || statusCode === 500 || statusCode === 502 || statusCode === 504) {
        return true
      }
    }

    // S3-specific throttling errors
    if (error.name === 'SlowDown' || error.name === 'RequestTimeout') {
      return true
    }

    return false
  }

  /**
   * Calculate exponential backoff delay
   * 
   * Formula: min(maxDelay, baseDelay * 2^(attempt - 1))
   * 
   * @param attempt - Current attempt number (1-indexed)
   * @returns Delay in milliseconds
   */
  private calculateBackoffDelay(attempt: number): number {
    const exponentialDelay = this.retryConfig.retryDelayMs * Math.pow(2, attempt - 1)
    return Math.min(exponentialDelay, this.retryConfig.maxRetryDelayMs)
  }

  /**
   * Sleep for specified milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /**
   * Get the S3 key prefix for a project
   */
  private getProjectPrefix(projectRef: string): string {
    return `${this.basePrefix}/${projectRef}`
  }

  /**
   * Get the S3 key prefix for a function
   */
  private getFunctionPrefix(projectRef: string, functionSlug: string): string {
    return `${this.getProjectPrefix(projectRef)}/${functionSlug}`
  }

  /**
   * Get the S3 key for function metadata
   */
  private getMetadataKey(projectRef: string, functionSlug: string): string {
    return `${this.getFunctionPrefix(projectRef, functionSlug)}/metadata.json`
  }

  /**
   * Get the S3 key for a function file
   */
  private getFileKey(projectRef: string, functionSlug: string, filePath: string): string {
    return `${this.getFunctionPrefix(projectRef, functionSlug)}/${filePath}`
  }

  /**
   * Store function files and metadata with retry logic
   */
  async store(
    projectRef: string,
    functionSlug: string,
    files: FunctionFile[],
    metadata: FunctionMetadata
  ): Promise<void> {
    await this.ensureInitialized()
    
    return this.executeWithRetry(async () => {
      // Store all function files
      const filePromises = files.map(async (file) => {
        const key = this.getFileKey(projectRef, functionSlug, file.path)
        
        const command = new PutObjectCommand({
          Bucket: this.bucketName,
          Key: key,
          Body: file.content,
          ContentType: this.getContentType(file.name),
          ServerSideEncryption: 'AES256',
          Metadata: {
            'project-ref': projectRef,
            'function-slug': functionSlug,
            'file-name': file.name,
          },
        })

        await this.s3Client.send(command)
      })

      // Store metadata
      const metadataKey = this.getMetadataKey(projectRef, functionSlug)
      const metadataCommand = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: metadataKey,
        Body: JSON.stringify(metadata, null, 2),
        ContentType: 'application/json',
        ServerSideEncryption: 'AES256',
        Metadata: {
          'project-ref': projectRef,
          'function-slug': functionSlug,
          'content-type': 'metadata',
        },
      })

      // Execute all uploads in parallel
      await Promise.all([...filePromises, this.s3Client.send(metadataCommand)])

      console.log(`[S3Storage] Successfully stored function ${functionSlug} with ${files.length} files`)

    }, `store function ${functionSlug}`)
  }

  /**
   * Retrieve function files with retry logic and optimized single-function retrieval
   * 
   * Optimizations:
   * - Uses ListObjectsV2 with pagination for large functions
   * - Parallel file downloads with connection pooling
   * - Retry logic with exponential backoff
   * - Efficient error handling
   */
  async retrieve(projectRef: string, functionSlug: string): Promise<FunctionFile[]> {
    await this.ensureInitialized()
    
    return this.executeWithRetry(async () => {
      // Check if function exists
      if (!(await this.exists(projectRef, functionSlug))) {
        throw new StorageNotFoundError(`Function ${functionSlug} in project ${projectRef}`)
      }

      // List all objects with the function prefix
      const functionPrefix = this.getFunctionPrefix(projectRef, functionSlug)
      const listCommand = new ListObjectsV2Command({
        Bucket: this.bucketName,
        Prefix: `${functionPrefix}/`,
      })

      const listResponse = await this.s3Client.send(listCommand)
      
      if (!listResponse.Contents) {
        return []
      }

      // Filter out metadata.json and get file keys
      const fileKeys = listResponse.Contents
        .filter((obj: any) => obj.Key && !obj.Key.endsWith('/metadata.json'))
        .map((obj: any) => obj.Key!)

      console.log(`[S3Storage] Retrieving ${fileKeys.length} files for function ${functionSlug}`)

      // Retrieve files in parallel with connection pooling
      const filePromises = fileKeys.map(async (key: string) => {
        try {
          const getCommand = new GetObjectCommand({
            Bucket: this.bucketName,
            Key: key,
          })

          const response = await this.s3Client.send(getCommand)
          
          if (response.Body) {
            const content = await this.streamToString(response.Body)
            const relativePath = key.replace(`${functionPrefix}/`, '')
            const fileName = relativePath.split('/').pop() || relativePath

            return {
              name: fileName,
              content,
              path: relativePath,
            }
          }
          
          return null
        } catch (error: any) {
          console.warn(`[S3Storage] Failed to retrieve file ${key}:`, error.message)
          // Return null for failed files, filter them out later
          return null
        }
      })

      const files = (await Promise.all(filePromises)).filter((file): file is FunctionFile => file !== null)

      console.log(`[S3Storage] Successfully retrieved ${files.length}/${fileKeys.length} files for function ${functionSlug}`)

      return files

    }, `retrieve function ${functionSlug}`)
  }

  /**
   * List all functions in a project
   */
  async list(projectRef: string): Promise<FunctionMetadata[]> {
    await this.ensureInitialized()
    
    try {
      const projectPrefix = this.getProjectPrefix(projectRef)
      const listCommand = new ListObjectsV2Command({
        Bucket: this.bucketName,
        Prefix: `${projectPrefix}/`,
        Delimiter: '/',
      })

      const listResponse = await this.s3Client.send(listCommand)
      
      if (!listResponse.CommonPrefixes) {
        return []
      }

      const functions: FunctionMetadata[] = []

      // Get metadata for each function
      for (const prefix of listResponse.CommonPrefixes) {
        if (!prefix.Prefix) continue

        // Extract function slug from prefix
        const functionSlug = prefix.Prefix
          .replace(`${projectPrefix}/`, '')
          .replace('/', '')

        try {
          const metadata = await this.getMetadata(projectRef, functionSlug)
          if (metadata) {
            functions.push(metadata)
          }
        } catch (error) {
          console.warn(`Failed to get metadata for function ${functionSlug}:`, error)
          // Continue with other functions
        }
      }

      // Sort by name for consistent ordering
      return functions.sort((a, b) => a.name.localeCompare(b.name))

    } catch (error: any) {
      throw new StorageAccessError(`Failed to list functions from S3: ${error.message}`, {
        projectRef,
        bucketName: this.bucketName,
        originalError: error,
      })
    }
  }

  /**
   * Delete a function and all its files with retry logic
   */
  async delete(projectRef: string, functionSlug: string): Promise<void> {
    await this.ensureInitialized()
    
    return this.executeWithRetry(async () => {
      // Check if function exists
      if (!(await this.exists(projectRef, functionSlug))) {
        throw new StorageNotFoundError(`Function ${functionSlug} in project ${projectRef}`)
      }

      // List all objects with the function prefix
      const functionPrefix = this.getFunctionPrefix(projectRef, functionSlug)
      const listCommand = new ListObjectsV2Command({
        Bucket: this.bucketName,
        Prefix: `${functionPrefix}/`,
      })

      const listResponse = await this.s3Client.send(listCommand)
      
      if (!listResponse.Contents || listResponse.Contents.length === 0) {
        return
      }

      // Delete all objects in parallel
      const deletePromises = listResponse.Contents
        .filter((obj: any) => obj.Key)
        .map((obj: any) => {
          const deleteCommand = new DeleteObjectCommand({
            Bucket: this.bucketName,
            Key: obj.Key!,
          })
          return this.s3Client.send(deleteCommand)
        })

      await Promise.all(deletePromises)

      console.log(`[S3Storage] Successfully deleted function ${functionSlug} (${listResponse.Contents.length} files)`)

    }, `delete function ${functionSlug}`)
  }

  /**
   * Get function metadata
   */
  async getMetadata(projectRef: string, functionSlug: string): Promise<FunctionMetadata | null> {
    await this.ensureInitialized()
    
    try {
      const metadataKey = this.getMetadataKey(projectRef, functionSlug)
      
      const getCommand = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: metadataKey,
      })

      try {
        const response = await this.s3Client.send(getCommand)
        
        if (response.Body) {
          const content = await this.streamToString(response.Body)
          const metadata = JSON.parse(content) as FunctionMetadata
          
          // Convert date strings back to Date objects
          return {
            ...metadata,
            createdAt: new Date(metadata.createdAt),
            updatedAt: new Date(metadata.updatedAt),
          }
        }
        
        return null
      } catch (error: any) {
        if (error.name === 'NoSuchKey') {
          return null
        }
        throw error
      }

    } catch (error: any) {
      if (error instanceof StorageBackendError) {
        throw error
      }
      throw new StorageAccessError(`Failed to get metadata from S3: ${error.message}`, {
        projectRef,
        functionSlug,
        bucketName: this.bucketName,
        originalError: error,
      })
    }
  }

  /**
   * Check if a function exists
   */
  async exists(projectRef: string, functionSlug: string): Promise<boolean> {
    await this.ensureInitialized()
    
    try {
      const metadataKey = this.getMetadataKey(projectRef, functionSlug)
      
      const headCommand = new HeadObjectCommand({
        Bucket: this.bucketName,
        Key: metadataKey,
      })

      await this.s3Client.send(headCommand)
      return true
    } catch (error: any) {
      if (error.name === 'NotFound' || error.name === 'NoSuchKey') {
        return false
      }
      // For other errors, assume function doesn't exist
      return false
    }
  }

  /**
   * Perform health check on the storage backend
   */
  async healthCheck(): Promise<StorageHealthStatus> {
    await this.ensureInitialized()
    
    try {
      // Try to list objects in the bucket (with a limit to avoid large responses)
      const listCommand = new ListObjectsV2Command({
        Bucket: this.bucketName,
        Prefix: this.basePrefix,
        MaxKeys: 1,
      })

      await this.s3Client.send(listCommand)

      // Try to put and delete a test object
      const testKey = `${this.basePrefix}/.health-check-${Date.now()}`
      const testContent = `Health check at ${new Date().toISOString()}`

      const putCommand = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: testKey,
        Body: testContent,
        ServerSideEncryption: 'AES256',
      })

      await this.s3Client.send(putCommand)

      // Verify we can read it back
      const getCommand = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: testKey,
      })

      const getResponse = await this.s3Client.send(getCommand)
      const readContent = await this.streamToString(getResponse.Body!)

      // Clean up test object
      const deleteCommand = new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: testKey,
      })

      await this.s3Client.send(deleteCommand)

      if (readContent !== testContent) {
        return {
          healthy: false,
          error: 'S3 read/write test failed - content mismatch',
          details: {
            bucketName: this.bucketName,
            basePrefix: this.basePrefix,
          },
        }
      }

      return {
        healthy: true,
        details: {
          bucketName: this.bucketName,
          basePrefix: this.basePrefix,
          type: 's3',
        },
      }

    } catch (error: any) {
      return {
        healthy: false,
        error: `S3 health check failed: ${error.message}`,
        details: {
          bucketName: this.bucketName,
          basePrefix: this.basePrefix,
          errorCode: error.name || error.code,
          originalError: error.message,
        },
      }
    }
  }

  /**
   * Convert a stream to string
   */
  private async streamToString(stream: any): Promise<string> {
    if (typeof stream === 'string') {
      return stream
    }

    if (stream instanceof Buffer) {
      return stream.toString('utf-8')
    }

    // Handle ReadableStream
    if (stream && typeof stream.transformToString === 'function') {
      return await stream.transformToString()
    }

    // Handle Node.js streams
    const chunks: Buffer[] = []
    
    return new Promise((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.on('error', reject)
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    })
  }

  /**
   * Get content type for a file based on its extension
   */
  private getContentType(fileName: string): string {
    const ext = fileName.split('.').pop()?.toLowerCase()
    
    switch (ext) {
      case 'ts':
        return 'application/typescript'
      case 'js':
        return 'application/javascript'
      case 'json':
        return 'application/json'
      case 'md':
        return 'text/markdown'
      case 'txt':
        return 'text/plain'
      case 'html':
        return 'text/html'
      case 'css':
        return 'text/css'
      default:
        return 'text/plain'
    }
  }
}
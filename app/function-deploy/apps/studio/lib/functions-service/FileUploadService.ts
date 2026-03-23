import { IncomingForm, File as FormidableFile, Fields, Files } from 'formidable'
import { NextApiRequest } from 'next'
import { promises as fs } from 'fs'
import path from 'path'
import { FunctionFile } from './storage/StorageBackend'

/**
 * File upload configuration
 */
export interface FileUploadConfig {
  /** Maximum file size in bytes (default: 10MB) */
  maxFileSize?: number
  /** Maximum total upload size in bytes (default: 50MB) */
  maxTotalSize?: number
  /** Allowed file extensions (default: ['.ts', '.js', '.json', '.md', '.txt']) */
  allowedExtensions?: string[]
  /** Maximum number of files (default: 100) */
  maxFiles?: number
  /** Temporary directory for uploads (default: system temp) */
  tempDir?: string
}

/**
 * Uploaded file information
 */
export interface UploadedFile {
  /** Original filename */
  originalName: string
  /** File content as string */
  content: string
  /** File size in bytes */
  size: number
  /** File extension */
  extension: string
  /** MIME type */
  mimeType: string
  /** Relative path within function */
  path: string
}

/**
 * File upload result
 */
export interface FileUploadResult {
  /** Successfully uploaded files */
  files: UploadedFile[]
  /** Import map content (if provided) */
  importMap?: string
  /** Function metadata (if provided) */
  metadata?: Record<string, any>
  /** Upload errors */
  errors: string[]
  /** Total size of uploaded files */
  totalSize: number
}

/**
 * File validation error
 */
export class FileValidationError extends Error {
  constructor(message: string, public code: string, public details?: any) {
    super(message)
    this.name = 'FileValidationError'
  }
}

/**
 * File Upload Service
 * 
 * Handles multipart form data uploads for Edge Functions with validation and processing.
 * Supports both storage backends and provides comprehensive file validation.
 */
export class FileUploadService {
  private config: Required<FileUploadConfig>

  constructor(config: FileUploadConfig = {}) {
    this.config = {
      maxFileSize: config.maxFileSize || 10 * 1024 * 1024, // 10MB
      maxTotalSize: config.maxTotalSize || 50 * 1024 * 1024, // 50MB
      allowedExtensions: config.allowedExtensions || ['.ts', '.js', '.json', '.md', '.txt', '.yaml', '.yml'],
      maxFiles: config.maxFiles || 100,
      tempDir: config.tempDir || '/tmp',
    }
  }

  /**
   * Parse multipart form data from request
   * 
   * @param req - Next.js API request
   * @returns Parsed form data
   */
  async parseFormData(req: NextApiRequest): Promise<{ fields: Fields; files: Files }> {
    return new Promise((resolve, reject) => {
      const form = new IncomingForm({
        maxFileSize: this.config.maxFileSize,
        maxTotalFileSize: this.config.maxTotalSize,
        maxFiles: this.config.maxFiles,
        uploadDir: this.config.tempDir,
        keepExtensions: true,
        multiples: true,
      })

      form.parse(req, (err, fields, files) => {
        if (err) {
          reject(new FileValidationError(
            `Failed to parse form data: ${err.message}`,
            'PARSE_ERROR',
            { originalError: err }
          ))
          return
        }

        resolve({ fields, files })
      })
    })
  }

  /**
   * Process uploaded files and convert to FunctionFile format
   * 
   * @param req - Next.js API request with multipart form data
   * @returns File upload result
   */
  async processFileUpload(req: NextApiRequest): Promise<FileUploadResult> {
    try {
      const { fields, files } = await this.parseFormData(req)
      
      const result: FileUploadResult = {
        files: [],
        errors: [],
        totalSize: 0,
      }

      // Process metadata if provided
      if (fields.metadata) {
        try {
          const metadataValue = Array.isArray(fields.metadata) ? fields.metadata[0] : fields.metadata
          result.metadata = JSON.parse(metadataValue as string)
        } catch (error) {
          result.errors.push('Invalid metadata JSON format')
        }
      }

      // Process import map if provided
      if (fields.importMap) {
        try {
          const importMapValue = Array.isArray(fields.importMap) ? fields.importMap[0] : fields.importMap
          const importMapContent = importMapValue as string
          JSON.parse(importMapContent) // Validate JSON
          result.importMap = importMapContent
        } catch (error) {
          result.errors.push('Invalid import map JSON format')
        }
      }

      // Process uploaded files
      const fileEntries = Object.entries(files)
      
      for (const [fieldName, fileOrFiles] of fileEntries) {
        const fileList = Array.isArray(fileOrFiles) ? fileOrFiles : [fileOrFiles]
        
        for (const file of fileList) {
          if (!file || typeof file === 'string') continue
          
          try {
            const uploadedFile = await this.processFile(file as FormidableFile, fieldName)
            result.files.push(uploadedFile)
            result.totalSize += uploadedFile.size
          } catch (error) {
            if (error instanceof FileValidationError) {
              result.errors.push(error.message)
            } else {
              result.errors.push(`Failed to process file: ${error instanceof Error ? error.message : 'Unknown error'}`)
            }
          }
        }
      }

      // Validate total upload size
      if (result.totalSize > this.config.maxTotalSize) {
        result.errors.push(`Total upload size (${this.formatBytes(result.totalSize)}) exceeds limit (${this.formatBytes(this.config.maxTotalSize)})`)
      }

      // Validate file count
      if (result.files.length > this.config.maxFiles) {
        result.errors.push(`Number of files (${result.files.length}) exceeds limit (${this.config.maxFiles})`)
      }

      return result

    } catch (error) {
      if (error instanceof FileValidationError) {
        throw error
      }
      
      throw new FileValidationError(
        `File upload processing failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'PROCESSING_ERROR',
        { originalError: error }
      )
    }
  }

  /**
   * Process a single uploaded file
   * 
   * @param file - Formidable file object
   * @param fieldName - Form field name
   * @returns Processed file information
   */
  private async processFile(file: FormidableFile, fieldName: string): Promise<UploadedFile> {
    const originalName = file.originalFilename || 'unknown'
    const extension = path.extname(originalName).toLowerCase()
    const size = file.size || 0

    // Validate file extension
    if (!this.config.allowedExtensions.includes(extension)) {
      throw new FileValidationError(
        `File extension '${extension}' is not allowed. Allowed extensions: ${this.config.allowedExtensions.join(', ')}`,
        'INVALID_EXTENSION',
        { filename: originalName, extension }
      )
    }

    // Validate file size
    if (size > this.config.maxFileSize) {
      throw new FileValidationError(
        `File '${originalName}' size (${this.formatBytes(size)}) exceeds limit (${this.formatBytes(this.config.maxFileSize)})`,
        'FILE_TOO_LARGE',
        { filename: originalName, size, limit: this.config.maxFileSize }
      )
    }

    // Read file content
    let content: string
    try {
      const buffer = await fs.readFile(file.filepath)
      content = buffer.toString('utf-8')
    } catch (error) {
      throw new FileValidationError(
        `Failed to read file '${originalName}': ${error instanceof Error ? error.message : 'Unknown error'}`,
        'READ_ERROR',
        { filename: originalName, originalError: error }
      )
    }

    // Validate content for code files
    if (['.ts', '.js'].includes(extension)) {
      this.validateCodeContent(content, originalName)
    }

    // Validate JSON files
    if (['.json'].includes(extension)) {
      this.validateJsonContent(content, originalName)
    }

    // Determine file path within function
    const filePath = this.determineFilePath(originalName, fieldName)

    // Clean up temporary file
    try {
      await fs.unlink(file.filepath)
    } catch (error) {
      console.warn(`Failed to clean up temporary file ${file.filepath}:`, error)
    }

    return {
      originalName,
      content,
      size,
      extension,
      mimeType: file.mimetype || 'application/octet-stream',
      path: filePath,
    }
  }

  /**
   * Validate TypeScript/JavaScript code content
   * 
   * @param content - File content
   * @param filename - File name for error reporting
   */
  private validateCodeContent(content: string, filename: string): void {
    // Basic syntax validation
    if (content.trim().length === 0) {
      throw new FileValidationError(
        `Code file '${filename}' cannot be empty`,
        'EMPTY_CODE_FILE',
        { filename }
      )
    }

    // Check for potentially dangerous patterns
    const dangerousPatterns = [
      /eval\s*\(/,
      /Function\s*\(/,
      /process\.exit/,
      /require\s*\(\s*['"]child_process['"]\s*\)/,
      /import.*child_process/,
    ]

    for (const pattern of dangerousPatterns) {
      if (pattern.test(content)) {
        throw new FileValidationError(
          `Code file '${filename}' contains potentially dangerous patterns`,
          'DANGEROUS_CODE',
          { filename, pattern: pattern.source }
        )
      }
    }

    // Validate basic TypeScript/JavaScript structure
    const hasValidStructure = 
      content.includes('export') || 
      content.includes('serve(') || 
      content.includes('function') ||
      content.includes('=>') ||
      content.includes('const') ||
      content.includes('let') ||
      content.includes('var')

    if (!hasValidStructure) {
      console.warn(`Code file '${filename}' may not have valid TypeScript/JavaScript structure`)
    }
  }

  /**
   * Validate JSON content
   * 
   * @param content - File content
   * @param filename - File name for error reporting
   */
  private validateJsonContent(content: string, filename: string): void {
    try {
      JSON.parse(content)
    } catch (error) {
      throw new FileValidationError(
        `JSON file '${filename}' contains invalid JSON: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'INVALID_JSON',
        { filename, originalError: error }
      )
    }
  }

  /**
   * Determine file path within function based on filename and field name
   * 
   * @param filename - Original filename
   * @param fieldName - Form field name
   * @returns File path within function
   */
  private determineFilePath(filename: string, fieldName: string): string {
    // Handle special field names that indicate directory structure
    if (fieldName.startsWith('static/') || fieldName.includes('/')) {
      return fieldName.endsWith('/') ? `${fieldName}${filename}` : fieldName
    }

    // Handle common file types
    const extension = path.extname(filename).toLowerCase()
    
    if (filename === 'import_map.json') {
      return 'import_map.json'
    }

    if (['.ts', '.js'].includes(extension) && filename !== 'index.ts' && filename !== 'index.js') {
      // Place non-index code files in src/ directory
      return `src/${filename}`
    }

    if (['.md', '.txt'].includes(extension)) {
      // Place documentation files in docs/ directory
      return `docs/${filename}`
    }

    if (['.yaml', '.yml'].includes(extension)) {
      // Place config files in config/ directory
      return `config/${filename}`
    }

    // Default to root level
    return filename
  }

  /**
   * Convert uploaded files to FunctionFile format
   * 
   * @param uploadedFiles - Uploaded files
   * @returns Function files
   */
  convertToFunctionFiles(uploadedFiles: UploadedFile[]): FunctionFile[] {
    return uploadedFiles.map(file => ({
      name: file.originalName,
      content: file.content,
      path: file.path,
    }))
  }

  /**
   * Validate function files for deployment
   * 
   * @param files - Function files to validate
   * @param entrypoint - Expected entrypoint file
   * @returns Validation result
   */
  validateFunctionFiles(files: FunctionFile[], entrypoint: string = 'index.ts'): {
    valid: boolean
    errors: string[]
    warnings: string[]
  } {
    const errors: string[] = []
    const warnings: string[] = []

    // Check for entrypoint file
    const hasEntrypoint = files.some(file => 
      file.path === entrypoint || file.name === entrypoint
    )

    if (!hasEntrypoint) {
      errors.push(`Entry point file '${entrypoint}' not found`)
    }

    // Check for duplicate file paths
    const pathCounts = new Map<string, number>()
    for (const file of files) {
      const count = pathCounts.get(file.path) || 0
      pathCounts.set(file.path, count + 1)
    }

    for (const [path, count] of pathCounts) {
      if (count > 1) {
        errors.push(`Duplicate file path: ${path}`)
      }
    }

    // Check for empty files
    for (const file of files) {
      if (file.content.trim().length === 0) {
        warnings.push(`File '${file.name}' is empty`)
      }
    }

    // Check for large files
    for (const file of files) {
      const size = Buffer.byteLength(file.content, 'utf-8')
      if (size > 1024 * 1024) { // 1MB
        warnings.push(`File '${file.name}' is large (${this.formatBytes(size)})`)
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    }
  }

  /**
   * Format bytes to human readable string
   * 
   * @param bytes - Number of bytes
   * @returns Formatted string
   */
  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 Bytes'
    
    const k = 1024
    const sizes = ['Bytes', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
  }

  /**
   * Get upload configuration
   */
  getConfig(): Required<FileUploadConfig> {
    return { ...this.config }
  }

  /**
   * Update upload configuration
   * 
   * @param config - New configuration
   */
  updateConfig(config: Partial<FileUploadConfig>): void {
    this.config = {
      ...this.config,
      ...config,
    }
  }
}

/**
 * Singleton instance
 */
let fileUploadService: FileUploadService | null = null

/**
 * Get the singleton FileUploadService instance
 */
export function getFileUploadService(config?: FileUploadConfig): FileUploadService {
  if (!fileUploadService) {
    fileUploadService = new FileUploadService(config)
  }
  return fileUploadService
}

/**
 * Reset the singleton instance (useful for testing)
 */
export function resetFileUploadService(): void {
  fileUploadService = null
}
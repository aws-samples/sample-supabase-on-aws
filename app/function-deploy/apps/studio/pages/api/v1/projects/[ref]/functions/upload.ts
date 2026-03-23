import { NextApiRequest, NextApiResponse } from 'next'
import { withSecureProjectAccess, ProjectIsolationContext } from 'lib/api/secure-api-wrapper'
import { getFileUploadService, FileValidationError } from 'lib/functions-service/FileUploadService'
import { withCORS } from 'lib/functions-service/cors/CORSMiddleware'

// Disable Next.js body parser for multipart form data
export const config = {
  api: {
    bodyParser: false,
  },
}

export default withCORS(
  withSecureProjectAccess(handler, {
    permissions: { read: true, write: true }
  }),
  {
    handlePreflight: true,
    addHeaders: true,
  }
)

async function handler(req: NextApiRequest, res: NextApiResponse, context: ProjectIsolationContext) {
  const { method } = req

  switch (method) {
    case 'POST':
      return handleFileUpload(req, res, context)
    default:
      res.setHeader('Allow', ['POST'])
      res.status(405).json({ 
        data: null, 
        error: { message: `Method ${method} Not Allowed` } 
      })
  }
}

const handleFileUpload = async (req: NextApiRequest, res: NextApiResponse, context: ProjectIsolationContext) => {
  try {
    const { projectRef } = context
    
    // Process file upload
    const fileUploadService = getFileUploadService()
    const uploadResult = await fileUploadService.processFileUpload(req)

    // Check for upload errors
    if (uploadResult.errors.length > 0) {
      return res.status(400).json({
        data: null,
        error: { 
          message: 'File upload validation failed',
          details: uploadResult.errors
        }
      })
    }

    // Validate that we have files
    if (uploadResult.files.length === 0) {
      return res.status(400).json({
        data: null,
        error: { 
          message: 'No valid files were uploaded'
        }
      })
    }

    // Convert to function files format
    const functionFiles = fileUploadService.convertToFunctionFiles(uploadResult.files)

    // Validate function files
    const entrypoint = uploadResult.metadata?.entrypoint || 'index.ts'
    const validation = fileUploadService.validateFunctionFiles(functionFiles, entrypoint)

    if (!validation.valid) {
      return res.status(400).json({
        data: null,
        error: { 
          message: 'Function files validation failed',
          details: validation.errors
        }
      })
    }

    // Return processed files and metadata
    const response = {
      projectRef,
      files: functionFiles.map(file => ({
        name: file.name,
        path: file.path,
        size: Buffer.byteLength(file.content, 'utf-8'),
        content: file.content,
      })),
      metadata: uploadResult.metadata,
      importMap: uploadResult.importMap,
      entrypoint,
      totalSize: uploadResult.totalSize,
      validation: {
        errors: validation.errors,
        warnings: validation.warnings,
      },
      uploadedAt: new Date().toISOString(),
    }

    return res.status(200).json({
      data: response,
      error: null
    })

  } catch (error) {
    console.error('Error processing file upload:', error)
    
    // Handle specific error cases
    if (error instanceof FileValidationError) {
      return res.status(400).json({
        data: null,
        error: { 
          message: error.message,
          code: error.code,
          details: error.details
        }
      })
    }
    
    return res.status(500).json({
      data: null,
      error: { 
        message: 'Failed to process file upload',
        details: error instanceof Error ? error.message : 'Unknown error'
      }
    })
  }
}
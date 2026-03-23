import { NextApiRequest, NextApiResponse } from 'next'
import { withSecureProjectAccess, ProjectIsolationContext } from 'lib/api/secure-api-wrapper'
import { getEdgeFunctionsClient } from 'lib/functions-service/EdgeFunctionsClient'
import { FunctionFile } from 'lib/functions-service/storage/StorageBackend'
import { withCORS } from 'lib/functions-service/cors/CORSMiddleware'
import formidable from 'formidable'
import { promises as fs } from 'fs'

// Disable Next.js body parsing for multipart/form-data
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
      return handleDeploy(req, res, context)
    default:
      res.setHeader('Allow', ['POST'])
      res.status(405).json({ 
        data: null, 
        error: { message: `Method ${method} Not Allowed` } 
      })
  }
}

const parseMultipartForm = async (req: NextApiRequest): Promise<{
  fields: formidable.Fields
  files: formidable.Files
}> => {
  return new Promise((resolve, reject) => {
    const form = formidable({
      multiples: true,
      keepExtensions: true,
    })

    form.parse(req, (err, fields, files) => {
      if (err) {
        reject(err)
      } else {
        resolve({ fields, files })
      }
    })
  })
}

const handleDeploy = async (req: NextApiRequest, res: NextApiResponse, context: ProjectIsolationContext) => {
  try {
    // Get project reference from context
    const { projectRef, userId } = context
    
    // Get slug from query parameters
    const { slug } = req.query
    
    if (!slug || typeof slug !== 'string') {
      return res.status(400).json({
        data: null,
        error: { 
          message: 'Function slug is required in query parameters' 
        }
      })
    }

    // Parse multipart form data
    const { fields, files } = await parseMultipartForm(req)
    
    // Extract metadata from form fields
    let metadata: any = {}
    if (fields.metadata) {
      try {
        const metadataValue = Array.isArray(fields.metadata) ? fields.metadata[0] : fields.metadata
        metadata = JSON.parse(metadataValue as string)
      } catch (error) {
        return res.status(400).json({
          data: null,
          error: { 
            message: 'Invalid metadata JSON format' 
          }
        })
      }
    }

    // Process uploaded files
    const functionFiles: FunctionFile[] = []
    
    if (files.file) {
      const fileArray = Array.isArray(files.file) ? files.file : [files.file]
      
      for (const file of fileArray) {
        if (file && file.filepath) {
          try {
            const content = await fs.readFile(file.filepath, 'utf-8')
            const fileName = file.originalFilename || file.newFilename || 'index.ts'
            
            console.debug(`[Deploy] Processing file: originalFilename="${file.originalFilename}", fileName="${fileName}"`)
            
            functionFiles.push({
              name: fileName,
              content,
              path: fileName,
            })
          } catch (error) {
            console.error('Error reading uploaded file:', error)
            return res.status(400).json({
              data: null,
              error: { 
                message: `Failed to read uploaded file: ${file.originalFilename}` 
              }
            })
          }
        }
      }
    }

    // Validate that we have at least one file
    if (functionFiles.length === 0) {
      return res.status(400).json({
        data: null,
        error: { 
          message: 'At least one file is required for deployment' 
        }
      })
    }

    // Validate function slug format (支持多级目录)
    if (!/^[a-z0-9][a-z0-9_\/-]*[a-z0-9]$/.test(slug)) {
      return res.status(400).json({
        data: null,
        error: { 
          message: 'Function slug must start and end with alphanumeric characters and contain only lowercase letters, numbers, hyphens, underscores, and forward slashes' 
        }
      })
    }

    // Extract import map if provided
    let importMap: string | undefined
    if (metadata.import_map_path) {
      const importMapFile = functionFiles.find(f => f.path === metadata.import_map_path)
      if (importMapFile) {
        importMap = importMapFile.content
        
        // Validate import map JSON
        try {
          JSON.parse(importMap)
        } catch (error) {
          return res.status(400).json({
            data: null,
            error: { 
              message: 'Import map must be valid JSON' 
            }
          })
        }
      }
    }

    // Prepare deployment data
    const deploymentData = {
      slug,
      files: functionFiles,
      metadata: {
        slug,
        name: metadata?.name || slug,
        description: metadata?.description || '',
        version: metadata?.version || '1.0.0',
        runtime: 'deno' as const,
        entrypoint: metadata?.entrypoint_path || 'index.ts',
        projectRef,
        userId,
      },
      importMap,
      entrypoint: metadata?.entrypoint_path || 'index.ts',
    }

    // Deploy function using EdgeFunctionsClient
    const edgeFunctionsClient = getEdgeFunctionsClient()
    const deploymentResult = await edgeFunctionsClient.deploy(projectRef, deploymentData)

    if (!deploymentResult.success) {
      return res.status(500).json({
        data: null,
        error: { 
          message: deploymentResult.error || 'Failed to deploy Edge Function',
          details: deploymentResult.details
        }
      })
    }

    // Prepare response with warnings if any
    const responseData: any = {
      slug: deploymentResult.metadata.slug,
      projectRef,
      name: deploymentResult.metadata.name,
      version: deploymentResult.metadata.version,
      status: 'deployed',
      deployedAt: deploymentResult.metadata.updatedAt,
      entrypoint: deploymentResult.metadata.entrypoint,
      runtime: deploymentResult.metadata.runtime,
    }

    // Add warnings if present (e.g., S3 write failures in dual-write mode)
    if (deploymentResult.warnings && deploymentResult.warnings.length > 0) {
      responseData.warnings = deploymentResult.warnings
      console.warn(`[Deploy] Deployment succeeded with warnings:`, deploymentResult.warnings)
    }

    return res.status(201).json({
      data: responseData,
      error: null
    })
  } catch (error) {
    console.error('Error deploying Edge Function:', error)
    
    // Handle specific error cases
    if (error instanceof Error) {
      if (error.message.includes('Function slug')) {
        return res.status(400).json({
          data: null,
          error: { 
            message: error.message
          }
        })
      }
      
      if (error.message.includes('storage')) {
        return res.status(503).json({
          data: null,
          error: { 
            message: 'Storage backend unavailable. Please check your configuration.',
            details: error.message
          }
        })
      }
    }
    
    return res.status(500).json({
      data: null,
      error: { 
        message: 'Failed to deploy Edge Function',
        details: error instanceof Error ? error.message : 'Unknown error'
      }
    })
  }
}
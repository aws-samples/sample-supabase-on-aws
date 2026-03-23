import { NextApiRequest, NextApiResponse } from 'next'
import { withSecureProjectAccess, ProjectIsolationContext } from 'lib/api/secure-api-wrapper'
import { getEdgeFunctionsClient } from 'lib/functions-service/EdgeFunctionsClient'
import { getFileUploadService } from 'lib/functions-service/FileUploadService'
import { FunctionFile, StorageNotFoundError } from 'lib/functions-service/storage/StorageBackend'
import { withCORS } from 'lib/functions-service/cors/CORSMiddleware'

export default withCORS(
  withSecureProjectAccess(handler, {
    permissions: { read: true }
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
      return handleValidateFunction(req, res, context)
    case 'GET':
      return handleValidateExistingFunction(req, res, context)
    default:
      res.setHeader('Allow', ['POST', 'GET'])
      res.status(405).json({ 
        data: null, 
        error: { message: `Method ${method} Not Allowed` } 
      })
  }
}

const handleValidateFunction = async (req: NextApiRequest, res: NextApiResponse, context: ProjectIsolationContext) => {
  try {
    const { projectRef } = context
    const { files, importMap, entrypoint } = req.body

    if (!files || !Array.isArray(files) || files.length === 0) {
      return res.status(400).json({
        data: null,
        error: { 
          message: 'Files array is required and must not be empty'
        }
      })
    }

    // Validate each file has required properties
    for (const file of files) {
      if (!file.name || file.content === undefined || file.content === null) {
        return res.status(400).json({
          data: null,
          error: { 
            message: 'Each file must have name and content properties' 
          }
        })
      }
      
      // Ensure file has path property (default to name if not provided)
      if (!file.path) {
        file.path = file.name
      }
    }

    // Validate import map if provided
    if (importMap) {
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

    // Convert to function files format
    const functionFiles: FunctionFile[] = files.map(file => ({
      name: file.name,
      content: file.content,
      path: file.path || file.name,
    }))

    // Validate function files structure
    const fileUploadService = getFileUploadService()
    const fileValidation = fileUploadService.validateFunctionFiles(functionFiles, entrypoint || 'index.ts')

    // Perform TypeScript validation using Deno runtime
    let denoValidation = {
      valid: true,
      errors: [] as string[],
      warnings: [] as string[],
    }

    try {
      // Create a temporary deployment for validation
      const edgeFunctionsClient = getEdgeFunctionsClient()
      
      // We'll use a temporary project ref for validation
      const tempProjectRef = `temp-validation-${Date.now()}`
      const tempSlug = `temp-function-${Date.now()}`
      
      const deploymentData = {
        slug: tempSlug,
        files: functionFiles,
        metadata: {
          name: 'temp-validation',
          description: 'Temporary function for validation',
          version: '1.0.0',
          runtime: 'deno' as const,
          entrypoint: entrypoint || 'index.ts',
          projectRef: tempProjectRef,
          userId: 'validation-user',
        },
        importMap,
        entrypoint: entrypoint || 'index.ts',
      }

      // Validate using EdgeFunctionsClient (this will use Deno runtime validation)
      const validationResult = await edgeFunctionsClient.validateFunction(tempProjectRef, tempSlug)
      
      denoValidation = {
        valid: validationResult.valid,
        errors: validationResult.errors,
        warnings: validationResult.warnings,
      }

      // Clean up temporary function if it was created
      try {
        await edgeFunctionsClient.delete(tempProjectRef, tempSlug)
      } catch (error) {
        // Ignore cleanup errors
      }

    } catch (error) {
      console.warn('Deno validation failed:', error)
      denoValidation = {
        valid: false,
        errors: [`Deno validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`],
        warnings: [],
      }
    }

    // Combine validation results
    const overallValid = fileValidation.valid && denoValidation.valid
    const allErrors = [...fileValidation.errors, ...denoValidation.errors]
    const allWarnings = [...fileValidation.warnings, ...denoValidation.warnings]

    const validationResponse = {
      valid: overallValid,
      errors: allErrors,
      warnings: allWarnings,
      fileValidation: {
        valid: fileValidation.valid,
        errors: fileValidation.errors,
        warnings: fileValidation.warnings,
      },
      denoValidation: {
        valid: denoValidation.valid,
        errors: denoValidation.errors,
        warnings: denoValidation.warnings,
      },
      summary: {
        totalFiles: functionFiles.length,
        entrypoint: entrypoint || 'index.ts',
        hasImportMap: !!importMap,
        validatedAt: new Date().toISOString(),
      },
    }

    return res.status(200).json({
      data: validationResponse,
      error: null
    })

  } catch (error) {
    console.error('Error validating function:', error)
    
    return res.status(500).json({
      data: null,
      error: { 
        message: 'Failed to validate function',
        details: error instanceof Error ? error.message : 'Unknown error'
      }
    })
  }
}

const handleValidateExistingFunction = async (req: NextApiRequest, res: NextApiResponse, context: ProjectIsolationContext) => {
  try {
    const { projectRef } = context
    const { slug } = req.query

    if (!slug || typeof slug !== 'string') {
      return res.status(400).json({
        data: null,
        error: { message: 'Function slug is required' }
      })
    }

    // Validate function slug format
    if (!/^[a-z0-9][a-z0-9_\/-]*[a-z0-9]$/.test(slug)) {
      return res.status(400).json({
        data: null,
        error: { 
          message: 'Function slug must start and end with alphanumeric characters and contain only lowercase letters, numbers, hyphens, underscores, and forward slashes' 
        }
      })
    }

    // Validate existing function using EdgeFunctionsClient
    const edgeFunctionsClient = getEdgeFunctionsClient()
    const validationResult = await edgeFunctionsClient.validateFunction(projectRef, slug)

    const validationResponse = {
      valid: validationResult.valid,
      errors: validationResult.errors,
      warnings: validationResult.warnings,
      summary: {
        functionSlug: slug,
        projectRef,
        validatedAt: new Date().toISOString(),
      },
    }

    return res.status(200).json({
      data: validationResponse,
      error: null
    })

  } catch (error) {
    console.error('Error validating existing function:', error)
    
    // Handle specific error cases
    if (error instanceof StorageNotFoundError) {
      return res.status(404).json({
        data: null,
        error: { 
          message: 'Function not found'
        }
      })
    }
    
    if (error instanceof Error && error.message.includes('storage')) {
      return res.status(503).json({
        data: null,
        error: { 
          message: 'Storage backend unavailable. Please check your configuration.',
          details: error.message
        }
      })
    }
    
    return res.status(500).json({
      data: null,
      error: { 
        message: 'Failed to validate function',
        details: error instanceof Error ? error.message : 'Unknown error'
      }
    })
  }
}
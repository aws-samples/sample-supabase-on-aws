import { NextApiRequest, NextApiResponse } from 'next'
import { withSecureProjectAccess, ProjectIsolationContext } from 'lib/api/secure-api-wrapper'
import { getImportMapService, ImportMapConfig } from 'lib/functions-service/ImportMapService'
import { getEdgeFunctionsClient } from 'lib/functions-service/EdgeFunctionsClient'
import { StorageNotFoundError } from 'lib/functions-service/storage/StorageBackend'
import { withCORS } from 'lib/functions-service/cors/CORSMiddleware'

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
      return handleValidateImportMap(req, res, context)
    case 'GET':
      return handleGetFunctionImportMap(req, res, context)
    default:
      res.setHeader('Allow', ['POST', 'GET'])
      res.status(405).json({ 
        data: null, 
        error: { message: `Method ${method} Not Allowed` } 
      })
  }
}

const handleValidateImportMap = async (req: NextApiRequest, res: NextApiResponse, context: ProjectIsolationContext) => {
  try {
    const { projectRef } = context
    const { importMap, files, generateFromFiles, packages } = req.body

    const importMapService = getImportMapService()

    let importMapConfig: ImportMapConfig

    if (generateFromFiles && files && Array.isArray(files)) {
      // Generate import map from function files
      const dependencies = importMapService.extractDependenciesFromFiles(files)
      importMapConfig = importMapService.createImportMap(dependencies)
      
    } else if (packages && Array.isArray(packages)) {
      // Generate import map from package list
      importMapConfig = importMapService.generateCommonImportMap(packages)
      
    } else if (importMap) {
      // Validate provided import map
      try {
        importMapConfig = importMapService.parseImportMap(importMap)
      } catch (error) {
        return res.status(400).json({
          data: null,
          error: { 
            message: `Invalid import map format: ${error instanceof Error ? error.message : 'Unknown error'}`
          }
        })
      }
    } else {
      return res.status(400).json({
        data: null,
        error: { 
          message: 'Either importMap, files with generateFromFiles=true, or packages array is required'
        }
      })
    }

    // Validate the import map
    const validation = await importMapService.validateImportMap(importMapConfig)

    // Optimize import map if files are provided
    let optimizedConfig = importMapConfig
    if (files && Array.isArray(files)) {
      optimizedConfig = importMapService.optimizeImportMap(importMapConfig, files)
    }

    // Create static file configuration if files are provided
    let staticFileConfig
    if (files && Array.isArray(files)) {
      staticFileConfig = importMapService.createStaticFileConfig(files)
    }

    const response = {
      projectRef,
      validation: {
        valid: validation.valid,
        errors: validation.errors,
        warnings: validation.warnings,
      },
      importMap: {
        original: importMapService.serializeImportMap(importMapConfig),
        optimized: importMapService.serializeImportMap(optimizedConfig),
        config: optimizedConfig,
      },
      dependencies: validation.dependencies,
      staticFiles: staticFileConfig,
      summary: {
        totalDependencies: validation.dependencies.length,
        npmPackages: validation.dependencies.filter(d => d.type === 'npm').length,
        denoModules: validation.dependencies.filter(d => d.type === 'deno').length,
        urlImports: validation.dependencies.filter(d => d.type === 'url').length,
        localImports: validation.dependencies.filter(d => d.type === 'local').length,
        staticFilePatterns: staticFileConfig?.patterns.length || 0,
        validatedAt: new Date().toISOString(),
      },
    }

    return res.status(200).json({
      data: response,
      error: null
    })

  } catch (error) {
    console.error('Error validating import map:', error)
    
    return res.status(500).json({
      data: null,
      error: { 
        message: 'Failed to validate import map',
        details: error instanceof Error ? error.message : 'Unknown error'
      }
    })
  }
}

const handleGetFunctionImportMap = async (req: NextApiRequest, res: NextApiResponse, context: ProjectIsolationContext) => {
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

    // Get function files
    const edgeFunctionsClient = getEdgeFunctionsClient()
    const functionInfo = await edgeFunctionsClient.get(projectRef, slug)

    // Find import map file
    const importMapFile = functionInfo.files.find(file => 
      file.name === 'import_map.json' || file.path === 'import_map.json'
    )

    const importMapService = getImportMapService()

    let importMapConfig: ImportMapConfig | null = null
    let validation = null

    if (importMapFile) {
      try {
        importMapConfig = importMapService.parseImportMap(importMapFile.content)
        validation = await importMapService.validateImportMap(importMapConfig)
      } catch (error) {
        return res.status(400).json({
          data: null,
          error: { 
            message: `Invalid import map in function: ${error instanceof Error ? error.message : 'Unknown error'}`
          }
        })
      }
    }

    // Extract dependencies from function files
    const extractedDependencies = importMapService.extractDependenciesFromFiles(
      functionInfo.files.filter(file => file.name !== 'import_map.json')
    )

    // Create static file configuration
    const staticFileConfig = importMapService.createStaticFileConfig(functionInfo.files)

    const response = {
      projectRef,
      functionSlug: slug,
      hasImportMap: !!importMapFile,
      importMap: importMapConfig ? {
        content: importMapFile?.content,
        config: importMapConfig,
        validation,
      } : null,
      extractedDependencies,
      staticFiles: staticFileConfig,
      suggestions: {
        // Suggest creating import map if dependencies found but no import map exists
        shouldCreateImportMap: extractedDependencies.length > 0 && !importMapFile,
        // Suggest optimizing if import map exists but has unused imports
        shouldOptimizeImportMap: importMapConfig && validation?.dependencies && 
          validation.dependencies.length > extractedDependencies.length,
      },
      summary: {
        totalFiles: functionInfo.files.length,
        codeFiles: functionInfo.files.filter(f => f.name.endsWith('.ts') || f.name.endsWith('.js')).length,
        staticFiles: staticFileConfig.patterns.length,
        extractedDependencies: extractedDependencies.length,
        importMapDependencies: validation?.dependencies.length || 0,
        analyzedAt: new Date().toISOString(),
      },
    }

    return res.status(200).json({
      data: response,
      error: null
    })

  } catch (error) {
    console.error('Error getting function import map:', error)
    
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
        message: 'Failed to get function import map',
        details: error instanceof Error ? error.message : 'Unknown error'
      }
    })
  }
}
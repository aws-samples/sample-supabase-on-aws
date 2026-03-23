import { NextApiRequest, NextApiResponse } from 'next'
import { withSecureProjectAccess, ProjectIsolationContext } from 'lib/api/secure-api-wrapper'
import { getImportMapService, DependencyInfo } from 'lib/functions-service/ImportMapService'
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
      return handleAnalyzeDependencies(req, res, context)
    case 'GET':
      return handleGetCommonDependencies(req, res, context)
    default:
      res.setHeader('Allow', ['POST', 'GET'])
      res.status(405).json({ 
        data: null, 
        error: { message: `Method ${method} Not Allowed` } 
      })
  }
}

const handleAnalyzeDependencies = async (req: NextApiRequest, res: NextApiResponse, context: ProjectIsolationContext) => {
  try {
    const { projectRef } = context
    const { files, code } = req.body

    if (!files && !code) {
      return res.status(400).json({
        data: null,
        error: { 
          message: 'Either files array or code string is required'
        }
      })
    }

    const importMapService = getImportMapService()
    let dependencies: DependencyInfo[] = []

    if (files && Array.isArray(files)) {
      // Analyze dependencies from multiple files
      dependencies = importMapService.extractDependenciesFromFiles(files)
    } else if (code && typeof code === 'string') {
      // Analyze dependencies from single code string
      dependencies = importMapService.extractDependenciesFromFiles([{
        name: 'temp.ts',
        content: code,
        path: 'temp.ts',
      }])
    }

    // Group dependencies by type
    const dependenciesByType = {
      npm: dependencies.filter(d => d.type === 'npm'),
      deno: dependencies.filter(d => d.type === 'deno'),
      url: dependencies.filter(d => d.type === 'url'),
      local: dependencies.filter(d => d.type === 'local'),
    }

    // Generate suggested import map
    const suggestedImportMap = importMapService.createImportMap(dependencies)

    // Validate the suggested import map
    const validation = await importMapService.validateImportMap(suggestedImportMap)

    const response = {
      projectRef,
      analysis: {
        totalDependencies: dependencies.length,
        dependenciesByType: {
          npm: dependenciesByType.npm.length,
          deno: dependenciesByType.deno.length,
          url: dependenciesByType.url.length,
          local: dependenciesByType.local.length,
        },
        dependencies,
        dependenciesByType,
      },
      suggestions: {
        importMap: importMapService.serializeImportMap(suggestedImportMap),
        importMapConfig: suggestedImportMap,
        validation: {
          valid: validation.valid,
          errors: validation.errors,
          warnings: validation.warnings,
        },
      },
      recommendations: {
        // Recommend using CDN for npm packages
        npmPackagesToCdn: dependenciesByType.npm.filter(d => !d.url.includes('esm.sh') && !d.url.includes('skypack') && !d.url.includes('jsdelivr')),
        // Recommend pinning versions for production
        unpinnedVersions: dependencies.filter(d => !d.version && d.type !== 'local'),
        // Recommend HTTPS for security
        insecureUrls: dependencies.filter(d => d.url.startsWith('http://')),
      },
      analyzedAt: new Date().toISOString(),
    }

    return res.status(200).json({
      data: response,
      error: null
    })

  } catch (error) {
    console.error('Error analyzing dependencies:', error)
    
    return res.status(500).json({
      data: null,
      error: { 
        message: 'Failed to analyze dependencies',
        details: error instanceof Error ? error.message : 'Unknown error'
      }
    })
  }
}

const handleGetCommonDependencies = async (req: NextApiRequest, res: NextApiResponse, context: ProjectIsolationContext) => {
  try {
    const { projectRef } = context
    const { category, cdn } = req.query

    // Define common dependency categories
    const commonDependencies = {
      web: [
        { name: 'react', description: 'A JavaScript library for building user interfaces' },
        { name: 'vue', description: 'The Progressive JavaScript Framework' },
        { name: 'svelte', description: 'Cybernetically enhanced web apps' },
        { name: 'lit', description: 'Simple. Fast. Web Components.' },
        { name: 'preact', description: 'Fast 3kB React alternative' },
      ],
      utility: [
        { name: 'lodash', description: 'A modern JavaScript utility library' },
        { name: 'ramda', description: 'A practical functional library for JavaScript' },
        { name: 'date-fns', description: 'Modern JavaScript date utility library' },
        { name: 'uuid', description: 'Generate RFC-compliant UUIDs' },
        { name: 'validator', description: 'String validation and sanitization' },
      ],
      http: [
        { name: 'axios', description: 'Promise based HTTP client' },
        { name: 'node-fetch', description: 'A light-weight module that brings window.fetch to Node.js' },
        { name: 'ky', description: 'Tiny & elegant JavaScript HTTP client' },
      ],
      crypto: [
        { name: 'crypto-js', description: 'JavaScript library of crypto standards' },
        { name: 'bcrypt', description: 'A library to help you hash passwords' },
        { name: 'jsonwebtoken', description: 'JSON Web Token implementation' },
      ],
      deno: [
        { name: 'std/http', url: 'https://deno.land/std@0.208.0/http/mod.ts', description: 'Deno standard HTTP library' },
        { name: 'std/fs', url: 'https://deno.land/std@0.208.0/fs/mod.ts', description: 'Deno standard file system utilities' },
        { name: 'std/path', url: 'https://deno.land/std@0.208.0/path/mod.ts', description: 'Deno standard path utilities' },
        { name: 'std/uuid', url: 'https://deno.land/std@0.208.0/uuid/mod.ts', description: 'Deno standard UUID utilities' },
        { name: 'std/datetime', url: 'https://deno.land/std@0.208.0/datetime/mod.ts', description: 'Deno standard date/time utilities' },
      ],
    }

    const importMapService = getImportMapService()
    const selectedCdn = (cdn as string) || 'esm.sh'

    let dependencies: any[] = []

    if (category && typeof category === 'string' && category in commonDependencies) {
      dependencies = commonDependencies[category as keyof typeof commonDependencies]
    } else {
      // Return all categories
      dependencies = Object.entries(commonDependencies).map(([cat, deps]) => ({
        category: cat,
        dependencies: deps,
      }))
    }

    // Generate import maps for each category if specific category requested
    let importMaps: Record<string, any> = {}
    
    if (category && typeof category === 'string' && category in commonDependencies) {
      const categoryDeps = commonDependencies[category as keyof typeof commonDependencies]
      
      if (category === 'deno') {
        // Deno dependencies already have URLs
        const denoImports: Record<string, string> = {}
        for (const dep of categoryDeps) {
          if ('url' in dep && dep.url) {
            denoImports[dep.name] = dep.url
          }
        }
        importMaps.deno = { imports: denoImports }
      } else {
        // Generate for different CDNs
        const cdns = ['esm.sh', 'skypack', 'jsdelivr'] as const
        
        for (const cdnName of cdns) {
          const packages = categoryDeps.map(dep => ({ name: dep.name, cdn: cdnName }))
          const importMapConfig = importMapService.generateCommonImportMap(packages)
          importMaps[cdnName] = importMapConfig
        }
      }
    }

    const response = {
      projectRef,
      category: category || 'all',
      cdn: selectedCdn,
      dependencies,
      importMaps,
      availableCategories: Object.keys(commonDependencies),
      availableCdns: ['esm.sh', 'skypack', 'jsdelivr'],
      usage: {
        // Provide usage examples
        examples: category === 'deno' ? {
          'std/http': `import { serve } from "https://deno.land/std@0.208.0/http/server.ts"`,
          'std/fs': `import { ensureDir } from "https://deno.land/std@0.208.0/fs/mod.ts"`,
          'std/path': `import { join } from "https://deno.land/std@0.208.0/path/mod.ts"`,
        } : {
          react: `import React from "react"`,
          lodash: `import _ from "lodash"`,
          axios: `import axios from "axios"`,
        },
      },
      generatedAt: new Date().toISOString(),
    }

    return res.status(200).json({
      data: response,
      error: null
    })

  } catch (error) {
    console.error('Error getting common dependencies:', error)
    
    return res.status(500).json({
      data: null,
      error: { 
        message: 'Failed to get common dependencies',
        details: error instanceof Error ? error.message : 'Unknown error'
      }
    })
  }
}
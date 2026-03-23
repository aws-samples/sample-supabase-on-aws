import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import { components } from 'api-types'
import {
  getFallbackEntrypointPath,
  getFallbackImportMapPath,
  getStaticPatterns,
} from 'components/interfaces/EdgeFunctions/EdgeFunctions.utils'
import { handleError, post } from 'data/fetchers'
import { IS_PLATFORM } from 'lib/constants'
import type { ResponseError, UseCustomMutationOptions } from 'types'
import { edgeFunctionsKeys } from './keys'

type EdgeFunctionsDeployBodyMetadata = components['schemas']['FunctionDeployBody']['metadata']
type EdgeFunctionsDeployVariables = {
  projectRef: string
  slug: string
  metadata: Partial<EdgeFunctionsDeployBodyMetadata>
  files: { name: string; content: string }[]
}

export async function deployEdgeFunction({
  projectRef,
  slug,
  metadata: _metadata,
  files,
}: EdgeFunctionsDeployVariables) {
  if (!projectRef) throw new Error('projectRef is required')

  // [Joshen] Consolidating this logic in the RQ since these values need to be set if they're not
  // provided from the callee, and their fallback values depends on the files provided
  const metadata = { ..._metadata }
  if (!_metadata.entrypoint_path) metadata.entrypoint_path = getFallbackEntrypointPath(files)
  if (!_metadata.import_map_path) metadata.import_map_path = getFallbackImportMapPath(files)
  if (!_metadata.static_patterns) metadata.static_patterns = getStaticPatterns(files)

  try {
    const { data, error } = await post(`/v1/projects/{ref}/functions/deploy`, {
      params: { path: { ref: projectRef }, query: { slug: slug } },
      body: {
        file: files as any,
        metadata: metadata as EdgeFunctionsDeployBodyMetadata,
      },
      bodySerializer(body) {
        const formData = new FormData()

        formData.append('metadata', JSON.stringify(body.metadata))

        body?.file?.forEach((f: any) => {
          const file = f as { name: string; content: string }
          const blob = new Blob([file.content], { type: 'text/plain' })
          formData.append('file', blob, file.name)
        })

        return formData
      },
    })

    if (error) {
      // Enhanced error handling for self-hosted deployments
      if (!IS_PLATFORM) {
        // Provide more specific error messages for self-hosted environments
        const errorMsg = (error as any)?.message || String(error)
        if (errorMsg.includes('ECONNREFUSED') || errorMsg.includes('fetch failed')) {
          throw new Error(
            'Failed to connect to Edge Functions service. Please ensure the Edge Functions container is running and accessible.'
          )
        }
        
        if (errorMsg.includes('404') || errorMsg.includes('Not Found')) {
          throw new Error(
            'Edge Functions deployment endpoint not found. Please check your Edge Functions service configuration.'
          )
        }
        
        if (errorMsg.includes('500') || errorMsg.includes('Internal Server Error')) {
          throw new Error(
            'Edge Functions service encountered an internal error. Please check the service logs for more details.'
          )
        }
      }
      
      handleError(error)
    }
    
    return data
  } catch (deploymentError) {
    // Additional error handling for deployment-specific issues
    if (!IS_PLATFORM) {
      const errorMessage = deploymentError instanceof Error ? deploymentError.message : 'Unknown deployment error'
      
      // Check if it's a network connectivity issue
      if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('fetch failed')) {
        throw new Error(
          'Cannot connect to Edge Functions service. Please verify that:\n' +
          '1. The Edge Functions container is running\n' +
          '2. The service is accessible at the configured endpoint\n' +
          '3. Network connectivity is working properly'
        )
      }
      
      // Check if it's a service configuration issue
      if (errorMessage.includes('ENOTFOUND') || errorMessage.includes('getaddrinfo')) {
        throw new Error(
          'Edge Functions service hostname could not be resolved. Please check your EDGE_FUNCTIONS_URL configuration.'
        )
      }
    }
    
    // Re-throw the original error if we can't provide a better message
    throw deploymentError
  }
}

type EdgeFunctionsDeployData = Awaited<ReturnType<typeof deployEdgeFunction>>

export const useEdgeFunctionDeployMutation = ({
  onSuccess,
  onError,
  ...options
}: Omit<
  UseCustomMutationOptions<EdgeFunctionsDeployData, ResponseError, EdgeFunctionsDeployVariables>,
  'mutationFn'
> = {}) => {
  const queryClient = useQueryClient()

  return useMutation<EdgeFunctionsDeployData, ResponseError, EdgeFunctionsDeployVariables>({
    mutationFn: (vars) => deployEdgeFunction(vars),
    async onSuccess(data, variables, context) {
      const { projectRef, slug } = variables
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: edgeFunctionsKeys.list(projectRef) }),
        queryClient.invalidateQueries({ queryKey: edgeFunctionsKeys.detail(projectRef, slug) }),
        queryClient.invalidateQueries({ queryKey: edgeFunctionsKeys.body(projectRef, slug) }),
      ])
      await onSuccess?.(data, variables, context)
    },
    async onError(data, variables, context) {
      if (onError === undefined) {
        // Enhanced error messages for self-hosted deployments
        const dataMsg = (data as any)?.message || String(data)
        let errorMessage = `Failed to deploy edge function: ${dataMsg}`
        
        if (!IS_PLATFORM) {
          // Provide more helpful error messages for self-hosted environments
          if (dataMsg.includes('Edge Functions service is not available')) {
            errorMessage = 'Edge Functions service is not available. Please ensure the service is running and accessible.'
          } else if (dataMsg.includes('Cannot connect to Edge Functions service')) {
            errorMessage = 'Cannot connect to Edge Functions service. Please check your service configuration and network connectivity.'
          } else if (dataMsg.includes('hostname could not be resolved')) {
            errorMessage = 'Edge Functions service hostname could not be resolved. Please check your EDGE_FUNCTIONS_URL configuration.'
          } else if (dataMsg.includes('deployment endpoint not found')) {
            errorMessage = 'Edge Functions deployment endpoint not found. Please verify your service configuration.'
          } else if (dataMsg.includes('internal error')) {
            errorMessage = 'Edge Functions service encountered an error. Please check the service logs for more details.'
          }
        }
        
        toast.error(errorMessage)
      } else {
        onError(data, variables, context)
      }
    },
    ...options,
  })
}

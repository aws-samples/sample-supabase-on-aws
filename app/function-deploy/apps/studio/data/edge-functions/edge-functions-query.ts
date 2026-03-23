import { useQuery } from '@tanstack/react-query'
import { components } from 'api-types'
import { get, handleError } from 'data/fetchers'
import { IS_PLATFORM } from 'lib/constants'
import { platformDetectionService } from 'lib/platform-detection'
import type { ResponseError, UseCustomQueryOptions } from 'types'
import { edgeFunctionsKeys } from './keys'

export type EdgeFunctionsVariables = { projectRef?: string }

export type EdgeFunctionsResponse = components['schemas']['FunctionResponse']

export async function getEdgeFunctions(
  { projectRef }: EdgeFunctionsVariables,
  signal?: AbortSignal
) {
  if (!projectRef) throw new Error('projectRef is required')

  // Use platform detection to determine the appropriate endpoint
  if (IS_PLATFORM) {
    // Platform environment - use standard API
    const { data, error } = await get(`/v1/projects/{ref}/functions`, {
      params: { path: { ref: projectRef } },
      signal,
    })

    if (error) handleError(error)
    return data
  } else {
    // Self-hosted environment - check service availability and route accordingly
    const serviceStatus = await platformDetectionService.validateLocalServices()
    
    if (!serviceStatus.available) {
      // If Edge Functions service is not available, return empty array
      // This allows the UI to show the local empty state with instructions
      console.warn('Edge Functions service not available:', serviceStatus.error)
      return []
    }

    // Try to get functions from the local Edge Functions service
    try {
      const { data, error } = await get(`/v1/projects/{ref}/functions`, {
        params: { path: { ref: projectRef } },
        signal,
      })

      if (error) {
        console.warn('Failed to fetch Edge Functions from local service:', error)
        // Return empty array instead of throwing to allow graceful degradation
        return []
      }
      
      // Normalize function metadata for consistent display
      const normalizedData = (data || []).map((func: any) => ({
        ...func,
        // Ensure name is properly set with fallback to slug
        name: func.name && func.name.trim() ? func.name : func.slug,
        // Add deployment source detection (these fields may not exist in the API response)
        deploymentSource: func.deploymentSource || 
                        (func.deployedViaStudio || func.source === 'studio' ? 'ui' : 
                         func.deployedViaAPI || func.source === 'api' ? 'api' : 'ui'),
        // Ensure timestamps are properly formatted (use existing fields)
        created_at: func.created_at || new Date().toISOString(),
        updated_at: func.updated_at || new Date().toISOString(),
      }))
      
      return normalizedData
    } catch (err) {
      console.warn('Error fetching Edge Functions:', err)
      // Return empty array to allow UI to show local instructions
      return []
    }
  }
}

export type EdgeFunctionsData = Awaited<ReturnType<typeof getEdgeFunctions>>
export type EdgeFunctionsError = ResponseError

export const useEdgeFunctionsQuery = <TData = EdgeFunctionsData>(
  { projectRef }: EdgeFunctionsVariables,
  {
    enabled = true,
    ...options
  }: UseCustomQueryOptions<EdgeFunctionsData, EdgeFunctionsError, TData> = {}
) =>
  useQuery<EdgeFunctionsData, EdgeFunctionsError, TData>({
    queryKey: edgeFunctionsKeys.list(projectRef),
    queryFn: ({ signal }) => getEdgeFunctions({ projectRef }, signal),
    enabled: enabled && typeof projectRef !== 'undefined',
    ...options,
  })

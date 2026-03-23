import { useQuery } from '@tanstack/react-query'
import { components } from 'api-types'
import { get, handleError } from 'data/fetchers'
import type { ResponseError, UseCustomQueryOptions } from 'types'
import { edgeFunctionsKeys } from './keys'

export type EdgeFunctionVariables = {
  projectRef?: string
  slug?: string
}

export type EdgeFunction = components['schemas']['FunctionSlugResponse']

export async function getEdgeFunction(
  { projectRef, slug }: EdgeFunctionVariables,
  signal?: AbortSignal
) {
  if (!projectRef) throw new Error('projectRef is required')
  if (!slug) throw new Error('slug is required')

  const { data, error } = await get(`/v1/projects/{ref}/functions/{function_slug}`, {
    params: { path: { ref: projectRef, function_slug: slug } },
    signal,
  })

  if (error) handleError(error)
  
  // Normalize function metadata for consistent display
  if (data) {
    return {
      ...data,
      // Ensure name is properly set with fallback to slug
      name: data.name && data.name.trim() ? data.name : data.slug || slug,
      // Add deployment source detection (these fields may not exist in the API response)
      deploymentSource: (data as any).deploymentSource || 
                      ((data as any).deployedViaStudio || (data as any).source === 'studio' ? 'ui' : 
                       (data as any).deployedViaAPI || (data as any).source === 'api' ? 'api' : 'ui'),
      // Ensure timestamps are properly formatted (use existing fields)
      created_at: data.created_at || new Date().toISOString(),
      updated_at: data.updated_at || new Date().toISOString(),
    }
  }
  
  return data
}

export type EdgeFunctionData = Awaited<ReturnType<typeof getEdgeFunction>>
export type EdgeFunctionError = ResponseError

export const useEdgeFunctionQuery = <TData = EdgeFunctionData>(
  { projectRef, slug }: EdgeFunctionVariables,
  {
    enabled = true,
    ...options
  }: UseCustomQueryOptions<EdgeFunctionData, EdgeFunctionError, TData> = {}
) =>
  useQuery<EdgeFunctionData, EdgeFunctionError, TData>({
    queryKey: edgeFunctionsKeys.detail(projectRef, slug),
    queryFn: ({ signal }) => getEdgeFunction({ projectRef, slug }, signal),
    enabled: enabled && typeof projectRef !== 'undefined' && typeof slug !== 'undefined',
    ...options,
  })

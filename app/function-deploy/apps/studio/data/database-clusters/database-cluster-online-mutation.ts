/**
 * Database Cluster Online Mutation
 * 
 * Mutation hook for bringing a cluster online
 * Validates: Requirements 5.1
 */

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import type { ResponseError, UseCustomMutationOptions } from 'types'
import { databaseClusterKeys } from './keys'

export type DatabaseClusterOnlineVariables = {
  identifier: string
}

export async function bringClusterOnline({
  identifier,
}: DatabaseClusterOnlineVariables) {
  // Use fetch directly to call the admin API
  const response = await fetch(`/admin/v1/online`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ identifier }),
  })

  if (!response.ok) {
    const error = await response.json()
    throw new Error(error?.error?.message || 'Failed to bring cluster online')
  }

  return await response.json()
}

type DatabaseClusterOnlineData = Awaited<ReturnType<typeof bringClusterOnline>>

export const useDatabaseClusterOnlineMutation = ({
  onError,
  onSuccess,
  ...options
}: Omit<
  UseCustomMutationOptions<DatabaseClusterOnlineData, ResponseError, DatabaseClusterOnlineVariables>,
  'mutationFn'
> = {}) => {
  const queryClient = useQueryClient()

  return useMutation<DatabaseClusterOnlineData, ResponseError, DatabaseClusterOnlineVariables>({
    mutationFn: (vars) => bringClusterOnline(vars),
    async onSuccess(data, variables, context) {
      await queryClient.invalidateQueries({ queryKey: databaseClusterKeys.metrics() })
      await queryClient.invalidateQueries({ queryKey: databaseClusterKeys.list() })
      await onSuccess?.(data, variables, context)
    },
    async onError(data, variables, context) {
      if (onError === undefined) {
        toast.error(`Failed to bring cluster online: ${data.message}`)
      } else {
        onError(data, variables, context)
      }
    },
    ...options,
  })
}

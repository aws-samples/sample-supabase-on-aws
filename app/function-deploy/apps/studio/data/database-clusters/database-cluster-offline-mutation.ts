/**
 * Database Cluster Offline Mutation
 * 
 * Mutation hook for taking a cluster offline
 * Validates: Requirements 5.2
 */

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import type { ResponseError, UseCustomMutationOptions } from 'types'
import { databaseClusterKeys } from './keys'

export type DatabaseClusterOfflineVariables = {
  identifier: string
}

export async function takeClusterOffline({
  identifier,
}: DatabaseClusterOfflineVariables) {
  // Use fetch directly to call the admin API
  const response = await fetch(`/admin/v1/offline`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ identifier }),
  })

  if (!response.ok) {
    const error = await response.json()
    throw new Error(error?.error?.message || 'Failed to take cluster offline')
  }

  return await response.json()
}

type DatabaseClusterOfflineData = Awaited<ReturnType<typeof takeClusterOffline>>

export const useDatabaseClusterOfflineMutation = ({
  onError,
  onSuccess,
  ...options
}: Omit<
  UseCustomMutationOptions<DatabaseClusterOfflineData, ResponseError, DatabaseClusterOfflineVariables>,
  'mutationFn'
> = {}) => {
  const queryClient = useQueryClient()

  return useMutation<DatabaseClusterOfflineData, ResponseError, DatabaseClusterOfflineVariables>({
    mutationFn: (vars) => takeClusterOffline(vars),
    async onSuccess(data, variables, context) {
      await queryClient.invalidateQueries({ queryKey: databaseClusterKeys.metrics() })
      await queryClient.invalidateQueries({ queryKey: databaseClusterKeys.list() })
      await onSuccess?.(data, variables, context)
    },
    async onError(data, variables, context) {
      if (onError === undefined) {
        toast.error(`Failed to take cluster offline: ${data.message}`)
      } else {
        onError(data, variables, context)
      }
    },
    ...options,
  })
}

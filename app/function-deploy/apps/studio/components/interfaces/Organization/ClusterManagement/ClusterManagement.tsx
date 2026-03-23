/**
 * Cluster Management Component
 * 
 * Main component for database cluster management interface
 * Validates: Requirements 12.1, 12.2, 12.3
 */

import { useState } from 'react'
import AlertError from 'components/ui/AlertError'
import { useDatabaseClusterMetricsQuery } from 'data/database-clusters'
import {
  useAllocationStrategiesQuery,
  useUpdateAllocationStrategyMutation,
  useActivateAllocationStrategyMutation,
  useDeleteAllocationStrategyMutation,
} from 'data/allocation-strategies'
import { LogoLoader } from 'ui'
import {
  ScaffoldContainer,
  ScaffoldSection,
  ScaffoldSectionTitle,
} from 'components/layouts/Scaffold'
import { ClusterTable } from './ClusterTable'
import { AddClusterForm } from './AddClusterForm'
import { PlatformMetricsSummary } from './PlatformMetricsSummary'
import { AllocationStrategyCard } from './AllocationStrategyCard'
import { EditStrategyModal } from './EditStrategyModal'
import { PlatformMonitoringChart } from './PlatformMonitoringChart'
import { ClusterMonitoringChart } from './ClusterMonitoringChart'
import type { AllocationStrategy } from './AllocationStrategyCard'

export const ClusterManagement = () => {
  const [showAddForm, setShowAddForm] = useState(false)
  const [editingStrategy, setEditingStrategy] = useState<AllocationStrategy | null>(null)
  const [selectedCluster, setSelectedCluster] = useState<{ identifier: string; name: string } | null>(null)

  const {
    data: metricsData,
    isPending: isLoadingMetrics,
    isError: isMetricsError,
    error: metricsError,
    refetch: refetchMetrics,
  } = useDatabaseClusterMetricsQuery()

  const {
    data: strategiesData,
    isPending: isLoadingStrategies,
    isError: isStrategiesError,
    error: strategiesError,
  } = useAllocationStrategiesQuery()

  const updateStrategyMutation = useUpdateAllocationStrategyMutation()
  const activateStrategyMutation = useActivateAllocationStrategyMutation()
  const deleteStrategyMutation = useDeleteAllocationStrategyMutation()

  const isLoading = isLoadingMetrics || isLoadingStrategies
  const isError = isMetricsError || isStrategiesError
  const error = metricsError || strategiesError

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <LogoLoader />
      </div>
    )
  }

  if (isError) {
    return <AlertError error={error} subject="Failed to load cluster data" />
  }

  const clusters = metricsData?.clusters || []
  const summary = metricsData?.summary
  const strategies = strategiesData?.strategies || []
  const activeStrategy = strategiesData?.active_strategy || null

  const handleActivateStrategy = async (strategyName: string) => {
    try {
      await activateStrategyMutation.mutateAsync(strategyName)
    } catch (error) {
      console.error('Failed to activate strategy:', error)
    }
  }

  const handleSaveStrategy = async (updates: Partial<AllocationStrategy>) => {
    if (!editingStrategy) return

    try {
      await updateStrategyMutation.mutateAsync({
        name: editingStrategy.name,
        updates,
      })
      setEditingStrategy(null)
    } catch (error) {
      console.error('Failed to update strategy:', error)
      throw error
    }
  }

  const handleDeleteStrategy = async (strategyName: string) => {
    try {
      await deleteStrategyMutation.mutateAsync(strategyName)
    } catch (error) {
      console.error('Failed to delete strategy:', error)
    }
  }

  return (
    <ScaffoldContainer>
      <ScaffoldSection isFullWidth>
        <div className="flex items-center justify-between mb-4">
          <ScaffoldSectionTitle>Database Clusters</ScaffoldSectionTitle>
        </div>

        {summary && <PlatformMetricsSummary summary={summary} />}

        {/* Allocation Strategy Section */}
        <div className="mt-6">
          <AllocationStrategyCard
            strategies={strategies}
            activeStrategy={activeStrategy}
            onActivate={handleActivateStrategy}
            onEdit={setEditingStrategy}
            onDelete={handleDeleteStrategy}
            isLoading={activateStrategyMutation.isPending || updateStrategyMutation.isPending || deleteStrategyMutation.isPending}
          />
        </div>

        {/* Clusters Table */}
        <div className="mt-6">
          <ClusterTable
            clusters={clusters}
            onRefresh={refetchMetrics}
            onAddCluster={() => setShowAddForm(true)}
            onSelectCluster={setSelectedCluster}
            selectedClusterIdentifier={selectedCluster?.identifier}
          />
        </div>

        {/* Platform Monitoring Chart (Requirement 16.1) */}
        <div className="mt-6">
          <PlatformMonitoringChart />
        </div>

        {/* Cluster-Specific Monitoring Chart (Requirement 17.1, 17.8, 17.9) */}
        {selectedCluster && (
          <div className="mt-6">
            <ClusterMonitoringChart
              clusterIdentifier={selectedCluster.identifier}
              clusterName={selectedCluster.name}
              onClose={() => setSelectedCluster(null)}
            />
          </div>
        )}

        {/* Add Cluster Form */}
        {showAddForm && (
          <AddClusterForm
            onClose={() => setShowAddForm(false)}
            onSuccess={() => {
              setShowAddForm(false)
              refetchMetrics()
            }}
          />
        )}

        {/* Edit Strategy Modal */}
        {editingStrategy && (
          <EditStrategyModal
            strategy={editingStrategy}
            visible={!!editingStrategy}
            onClose={() => setEditingStrategy(null)}
            onSave={handleSaveStrategy}
          />
        )}
      </ScaffoldSection>
    </ScaffoldContainer>
  )
}

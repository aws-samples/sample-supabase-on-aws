/**
 * Platform Metrics Summary Component
 * 
 * Displays platform-wide capacity metrics with 80% utilization warning
 * Validates: Requirements 10.1, 10.2, 10.3, 10.4
 */

import { PlatformMetrics } from 'data/database-clusters/database-cluster-metrics-query'
import { Card, Badge } from 'ui'
import { AlertTriangle } from 'lucide-react'

interface PlatformMetricsSummaryProps {
  summary: PlatformMetrics
}

export const PlatformMetricsSummary = ({ summary }: PlatformMetricsSummaryProps) => {
  const getUtilizationColor = (utilization: number) => {
    if (utilization >= 80) return 'text-red-600'
    if (utilization >= 60) return 'text-yellow-600'
    return 'text-green-600'
  }

  // Platform-level 80% capacity warning
  const showCapacityWarning = summary.platform_utilization_percentage >= 80

  return (
    <>
      {showCapacityWarning && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-red-600 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <h4 className="text-sm font-semibold text-red-900 mb-1">
              Platform Capacity Warning
            </h4>
            <p className="text-sm text-red-800">
              Platform utilization has reached {summary.platform_utilization_percentage.toFixed(1)}%. 
              Consider adding more clusters or increasing capacity to ensure continued service availability.
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <Card className="p-4">
          <div className="space-y-1">
            <p className="text-sm text-foreground-light">Total Clusters</p>
            <p className="text-2xl font-semibold">{summary.total_clusters}</p>
            <p className="text-xs text-foreground-light">
              {summary.online_clusters} online, {summary.offline_clusters} offline
            </p>
          </div>
        </Card>

        <Card className="p-4">
          <div className="space-y-1">
            <p className="text-sm text-foreground-light">Platform Capacity</p>
            <p className="text-2xl font-semibold">{summary.total_capacity}</p>
            <p className="text-xs text-foreground-light">
              {summary.total_allocated} allocated
            </p>
          </div>
        </Card>

        <Card className={`p-4 ${showCapacityWarning ? 'border-2 border-red-200 bg-red-50' : ''}`}>
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <p className="text-sm text-foreground-light">Platform Utilization</p>
              {showCapacityWarning && (
                <Badge variant="destructive" className="text-xs">
                  Warning
                </Badge>
              )}
            </div>
            <p className={`text-2xl font-semibold ${getUtilizationColor(summary.platform_utilization_percentage)}`}>
              {summary.platform_utilization_percentage.toFixed(1)}%
            </p>
            {showCapacityWarning && (
              <p className="text-xs text-red-600 font-medium">
                Capacity threshold exceeded
              </p>
            )}
          </div>
        </Card>

        <Card className="p-4">
          <div className="space-y-1">
            <p className="text-sm text-foreground-light">Utilization Range</p>
            {summary.max_utilized_cluster && summary.min_utilized_cluster ? (
              <>
                <p className="text-xs">
                  <span className="text-foreground-light">Max: </span>
                  <span className="font-mono text-sm">
                    {summary.max_utilized_cluster.identifier}
                  </span>
                  <span className={`ml-2 ${getUtilizationColor(summary.max_utilized_cluster.utilization_percentage)}`}>
                    {summary.max_utilized_cluster.utilization_percentage.toFixed(1)}%
                  </span>
                </p>
                <p className="text-xs">
                  <span className="text-foreground-light">Min: </span>
                  <span className="font-mono text-sm">
                    {summary.min_utilized_cluster.identifier}
                  </span>
                  <span className={`ml-2 ${getUtilizationColor(summary.min_utilized_cluster.utilization_percentage)}`}>
                    {summary.min_utilized_cluster.utilization_percentage.toFixed(1)}%
                  </span>
                </p>
              </>
            ) : (
              <p className="text-sm text-foreground-light">No data</p>
            )}
          </div>
        </Card>
      </div>
    </>
  )
}

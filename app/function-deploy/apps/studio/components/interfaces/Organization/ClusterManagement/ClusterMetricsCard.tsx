/**
 * Cluster Metrics Card Component
 * 
 * Displays per-cluster capacity metrics with visual indicators
 * Validates: Requirements 11.1, 11.2, 11.3
 */

import { Cluster } from 'data/database-clusters'
import { Card, Badge } from 'ui'
import { AlertTriangle, CheckCircle, AlertCircle } from 'lucide-react'

interface ClusterMetricsCardProps {
  cluster: Cluster & { utilization_percentage: number }
}

export const ClusterMetricsCard = ({ cluster }: ClusterMetricsCardProps) => {
  /**
   * Calculate utilization percentage
   * Requirements: 11.2
   */
  const utilizationPercentage = cluster.utilization_percentage

  /**
   * Get visual indicator based on utilization
   * Requirements: 11.3
   * Note: No capacity threshold warnings at cluster level since allocation
   * stops automatically when max capacity is reached
   */
  const getUtilizationIndicator = () => {
    // Simple color coding based on utilization percentage
    if (utilizationPercentage >= 90) {
      return {
        icon: <AlertCircle className="h-5 w-5 text-red-600" />,
        color: 'text-red-600',
        bgColor: 'bg-red-50',
        borderColor: 'border-default',
        label: 'Near Capacity',
        variant: 'default' as const,
      }
    } else if (utilizationPercentage >= 70) {
      return {
        icon: <AlertCircle className="h-5 w-5 text-yellow-600" />,
        color: 'text-yellow-600',
        bgColor: 'bg-yellow-50',
        borderColor: 'border-default',
        label: 'Active',
        variant: 'default' as const,
      }
    } else {
      return {
        icon: <CheckCircle className="h-5 w-5 text-green-600" />,
        color: 'text-green-600',
        bgColor: 'bg-green-50',
        borderColor: 'border-default',
        label: 'Available',
        variant: 'default' as const,
      }
    }
  }

  const indicator = getUtilizationIndicator()
  const availableCapacity = cluster.max_databases - cluster.current_databases

  return (
    <Card className={`p-4 border-2 ${indicator.borderColor}`}>
      <div className="space-y-3">
        {/* Header with cluster name and status */}
        <div className="flex items-start justify-between">
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold truncate">{cluster.name}</h3>
            <p className="text-xs text-foreground-light font-mono truncate">
              {cluster.identifier}
            </p>
          </div>
          <div className="ml-2 flex-shrink-0">
            {indicator.icon}
          </div>
        </div>

        {/* Utilization percentage - Requirements: 11.1, 11.2 */}
        <div className={`${indicator.bgColor} rounded-lg p-3`}>
          <div className="flex items-baseline justify-between">
            <span className="text-xs text-foreground-light">Utilization</span>
            <span className={`text-2xl font-bold ${indicator.color}`}>
              {utilizationPercentage.toFixed(1)}%
            </span>
          </div>
        </div>

        {/* Capacity metrics - Requirements: 11.1 */}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <p className="text-xs text-foreground-light">Current</p>
            <p className="text-lg font-semibold">{cluster.current_databases}</p>
          </div>
          <div className="space-y-1">
            <p className="text-xs text-foreground-light">Max Capacity</p>
            <p className="text-lg font-semibold">{cluster.max_databases}</p>
          </div>
        </div>

        {/* Available capacity */}
        <div className="pt-2 border-t border-border">
          <div className="flex items-center justify-between">
            <span className="text-xs text-foreground-light">Available</span>
            <span className="text-sm font-medium">
              {availableCapacity} databases
            </span>
          </div>
        </div>

        {/* Status badge and region */}
        <div className="flex items-center justify-between pt-2">
          <Badge variant={indicator.variant} className="text-xs">
            {indicator.label}
          </Badge>
          <span className="text-xs text-foreground-light">
            {cluster.region}
          </span>
        </div>
      </div>
    </Card>
  )
}

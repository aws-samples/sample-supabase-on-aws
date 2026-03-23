/**
 * Cluster Monitoring Chart Component
 * 
 * Displays cluster-specific capacity and utilization metrics over time
 * Validates: Requirements 17.1, 17.2, 17.3, 17.4, 17.5, 17.6, 17.7
 */

import { useState } from 'react'
import { LineChart, Line, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine } from 'recharts'
import { Button } from 'ui'
import { RefreshCw, X } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import AlertError from 'components/ui/AlertError'
import type { ResponseError } from 'types'

type TimeRange = '1h' | '6h' | '24h' | '7d' | '30d'

interface ClusterMetricsDataPoint {
  timestamp: string
  max_databases: number
  current_databases: number
  utilization_percentage: number
}

interface ClusterMetricsResponse {
  cluster: {
    identifier: string
    name: string
  }
  time_range: {
    start: string
    end: string
    interval: '5m' | '1h' | '1d'
  }
  metrics: ClusterMetricsDataPoint[]
}

interface ClusterMonitoringChartProps {
  clusterIdentifier: string
  clusterName: string
  onClose?: () => void
}

const TIME_RANGE_OPTIONS: { value: TimeRange; label: string }[] = [
  { value: '1h', label: '1 Hour' },
  { value: '6h', label: '6 Hours' },
  { value: '24h', label: '24 Hours' },
  { value: '7d', label: '7 Days' },
  { value: '30d', label: '30 Days' },
]

const getTimeRangeInMs = (range: TimeRange): number => {
  const ranges: Record<TimeRange, number> = {
    '1h': 60 * 60 * 1000,
    '6h': 6 * 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
  }
  return ranges[range]
}

const formatTimestamp = (timestamp: string, interval: string): string => {
  const date = new Date(timestamp)
  
  if (interval === '5m' || interval === '1h') {
    // Show time for short intervals
    return date.toLocaleTimeString('en-US', { 
      hour: '2-digit', 
      minute: '2-digit',
      hour12: false 
    })
  } else {
    // Show date for longer intervals
    return date.toLocaleDateString('en-US', { 
      month: 'short', 
      day: 'numeric' 
    })
  }
}

export const ClusterMonitoringChart = ({ 
  clusterIdentifier, 
  clusterName,
  onClose 
}: ClusterMonitoringChartProps) => {
  const [timeRange, setTimeRange] = useState<TimeRange>('24h') // Default: 24h
  const [autoRefresh, setAutoRefresh] = useState(true)

  const fetchClusterMetrics = async (): Promise<ClusterMetricsResponse> => {
    const endTime = new Date()
    const startTime = new Date(endTime.getTime() - getTimeRangeInMs(timeRange))

    const params = new URLSearchParams({
      start_time: startTime.toISOString(),
      end_time: endTime.toISOString(),
    })

    // Use relative URL to go through Kong which handles authentication
    const url = `/admin/v1/metrics/cluster/${clusterIdentifier}?${params}`

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    })

    if (!response.ok) {
      const error = await response.json()
      throw new Error(error?.error?.message || 'Failed to fetch cluster metrics')
    }

    return await response.json()
  }

  const {
    data,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['cluster-metrics', clusterIdentifier, timeRange],
    queryFn: fetchClusterMetrics,
    refetchInterval: autoRefresh ? 30000 : false, // Auto-refresh every 30 seconds
  })

  // Format data for chart
  const chartData = data?.metrics.map((point) => ({
    time: formatTimestamp(point.timestamp, data.time_range.interval),
    capacity: point.max_databases,
    utilizationPct: point.utilization_percentage,
  })) || []

  // Check if any data point exceeds 80% threshold (Requirement 17.7)
  const hasHighUtilization = chartData.some(point => point.utilizationPct > 80)

  if (isError) {
    return (
      <div className="border rounded-lg p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-medium">Cluster: {clusterName}</h3>
          {onClose && (
            <Button type="text" size="tiny" icon={<X size={14} />} onClick={onClose} />
          )}
        </div>
        <AlertError error={error} subject="Failed to load cluster metrics" />
      </div>
    )
  }

  return (
    <div className="border rounded-lg p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h3 className="text-lg font-medium">Cluster: {clusterName}</h3>
          <p className="text-sm text-foreground-light">{clusterIdentifier}</p>
        </div>
        
        <div className="flex items-center gap-3">
          {/* Time Range Selector (Requirement 17.4) */}
          <div className="flex gap-1">
            {TIME_RANGE_OPTIONS.map((option) => (
              <Button
                key={option.value}
                type={timeRange === option.value ? 'default' : 'outline'}
                size="tiny"
                onClick={() => setTimeRange(option.value)}
              >
                {option.label}
              </Button>
            ))}
          </div>

          {/* Auto-refresh toggle */}
          <Button
            type="outline"
            size="tiny"
            icon={<RefreshCw size={14} />}
            onClick={() => setAutoRefresh(!autoRefresh)}
            className={autoRefresh ? 'text-brand-600' : ''}
          >
            {autoRefresh ? 'Auto' : 'Manual'}
          </Button>

          {/* Manual refresh button */}
          <Button
            type="outline"
            size="tiny"
            icon={<RefreshCw size={14} />}
            onClick={() => refetch()}
            loading={isLoading}
          >
            Refresh
          </Button>

          {/* Close button */}
          {onClose && (
            <Button type="text" size="tiny" icon={<X size={14} />} onClick={onClose} />
          )}
        </div>
      </div>

      {/* High utilization warning (Requirement 17.7) */}
      {hasHighUtilization && (
        <div className="mb-4 p-3 bg-warning-200 border border-warning-400 rounded-md">
          <p className="text-sm text-warning-900">
            ⚠️ This cluster has exceeded 80% capacity utilization in the selected time range
          </p>
        </div>
      )}

      {isLoading && !data ? (
        <div className="flex items-center justify-center h-64">
          <div className="text-sm text-foreground-light">Loading metrics...</div>
        </div>
      ) : chartData.length === 0 ? (
        <div className="flex items-center justify-center h-64">
          <div className="text-sm text-foreground-light">
            No metrics data available for the selected time range
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Capacity Chart */}
          <div>
            <h4 className="text-sm font-medium mb-3">Cluster Capacity</h4>
            <ResponsiveContainer width="100%" height={250}>
              <AreaChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis 
                  dataKey="time" 
                  className="text-xs"
                  tick={{ fill: 'hsl(var(--foreground-light))' }}
                />
                <YAxis 
                  className="text-xs"
                  tick={{ fill: 'hsl(var(--foreground-light))' }}
                  label={{ 
                    value: 'Databases', 
                    angle: -90, 
                    position: 'insideLeft',
                    style: { fill: 'hsl(var(--foreground-light))' }
                  }}
                />
                <Tooltip 
                  contentStyle={{ 
                    backgroundColor: 'hsl(var(--background-surface-100))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: '6px'
                  }}
                />
                <Legend />
                <Area
                  type="monotone"
                  dataKey="capacity"
                  name="Max Capacity"
                  stroke="hsl(var(--brand-600))"
                  fill="hsl(var(--brand-400))"
                  fillOpacity={0.6}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          {/* Utilization Percentage Chart with 80% threshold line */}
          <div>
            <h4 className="text-sm font-medium mb-3">Utilization Percentage</h4>
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis 
                  dataKey="time" 
                  className="text-xs"
                  tick={{ fill: 'hsl(var(--foreground-light))' }}
                />
                <YAxis 
                  className="text-xs"
                  tick={{ fill: 'hsl(var(--foreground-light))' }}
                  domain={[0, 100]}
                  label={{ 
                    value: 'Utilization %', 
                    angle: -90, 
                    position: 'insideLeft',
                    style: { fill: 'hsl(var(--foreground-light))' }
                  }}
                />
                <Tooltip 
                  contentStyle={{ 
                    backgroundColor: 'hsl(var(--background-surface-100))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: '6px'
                  }}
                  formatter={(value: number) => `${value.toFixed(2)}%`}
                />
                <Legend />
                {/* 80% threshold line (Requirement 17.7) */}
                <ReferenceLine 
                  y={80} 
                  stroke="hsl(var(--warning-600))" 
                  strokeDasharray="3 3"
                  label={{ 
                    value: '80% Threshold', 
                    position: 'right',
                    fill: 'hsl(var(--warning-600))'
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="utilizationPct"
                  name="Utilization %"
                  stroke="hsl(var(--brand-600))"
                  strokeWidth={2}
                  dot={{ fill: 'hsl(var(--brand-600))' }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  )
}

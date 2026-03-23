/**
 * Platform Monitoring Chart Component
 * 
 * Displays platform-wide capacity and utilization metrics over time
 * Validates: Requirements 16.1, 16.2, 16.3, 16.4, 16.6, 16.7
 */

import { useState, useEffect } from 'react'
import { LineChart, Line, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts'
import { Button } from 'ui'
import { RefreshCw } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import AlertError from 'components/ui/AlertError'
import type { ResponseError } from 'types'

type TimeRange = '1h' | '6h' | '24h' | '7d' | '30d'

interface PlatformMetricsDataPoint {
  timestamp: string
  total_capacity: number
  total_utilization: number
  utilization_percentage: number
}

interface PlatformMetricsResponse {
  time_range: {
    start: string
    end: string
    interval: '5m' | '1h' | '1d'
  }
  metrics: PlatformMetricsDataPoint[]
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

export const PlatformMonitoringChart = () => {
  const [timeRange, setTimeRange] = useState<TimeRange>('24h') // Default: 24h (Requirement 16.4)
  const [autoRefresh, setAutoRefresh] = useState(true)

  const fetchPlatformMetrics = async (): Promise<PlatformMetricsResponse> => {
    const endTime = new Date()
    const startTime = new Date(endTime.getTime() - getTimeRangeInMs(timeRange))

    const params = new URLSearchParams({
      start_time: startTime.toISOString(),
      end_time: endTime.toISOString(),
    })

    // Use relative URL to go through Kong which handles authentication
    const url = `/admin/v1/metrics/platform?${params}`

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    })

    if (!response.ok) {
      const error = await response.json()
      throw new Error(error?.error?.message || 'Failed to fetch platform metrics')
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
    queryKey: ['platform-metrics', timeRange],
    queryFn: fetchPlatformMetrics,
    refetchInterval: autoRefresh ? 30000 : false, // Auto-refresh every 30 seconds (Requirement 16.8)
  })

  // Format data for chart
  const chartData = data?.metrics.map((point) => ({
    time: formatTimestamp(point.timestamp, data.time_range.interval),
    capacity: point.total_capacity,
    utilizationPct: point.utilization_percentage,
  })) || []

  if (isError) {
    return (
      <div className="border rounded-lg p-6">
        <h3 className="text-lg font-medium mb-4">Platform Capacity & Utilization</h3>
        <AlertError error={error} subject="Failed to load platform metrics" />
      </div>
    )
  }

  return (
    <div className="border rounded-lg p-6">
      <div className="flex items-center justify-between mb-6">
        <h3 className="text-lg font-medium">Platform Capacity & Utilization</h3>
        
        <div className="flex items-center gap-3">
          {/* Time Range Selector (Requirement 16.3) */}
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
        </div>
      </div>

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
            <h4 className="text-sm font-medium mb-3">Total Platform Capacity</h4>
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
                  name="Total Capacity"
                  stroke="hsl(var(--brand-600))"
                  fill="hsl(var(--brand-400))"
                  fillOpacity={0.6}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          {/* Utilization Percentage Chart */}
          <div>
            <h4 className="text-sm font-medium mb-3">Platform Utilization Percentage</h4>
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

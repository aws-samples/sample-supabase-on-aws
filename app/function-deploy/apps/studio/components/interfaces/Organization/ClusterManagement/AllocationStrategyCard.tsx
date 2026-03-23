/**
 * Allocation Strategy Card Component
 * 
 * Displays and manages allocation strategies for cluster assignment
 * Validates: Requirements 7.1, 7.2, 12.3
 */

import { useState } from 'react'
import { Button, Badge } from 'ui'
import { Check, Edit2, Settings, Trash2 } from 'lucide-react'

export interface AllocationStrategy {
  id: string
  name: string
  strategy_type: 'manual' | 'hash' | 'round_robin' | 'weighted_round_robin' | 'least_connections'
  description: string | null
  config: Record<string, any> | null
  is_active: boolean
  created_at: string
  updated_at: string
}

interface AllocationStrategyCardProps {
  strategies: AllocationStrategy[]
  activeStrategy: AllocationStrategy | null
  onActivate: (strategyName: string) => void
  onEdit: (strategy: AllocationStrategy) => void
  onDelete: (strategyName: string) => void
  isLoading?: boolean
}

const strategyTypeLabels: Record<string, string> = {
  manual: 'Manual',
  hash: 'Hash-Based',
  round_robin: 'Round Robin',
  weighted_round_robin: 'Weighted Round Robin',
  least_connections: 'Least Connections',
}

const strategyTypeColors: Record<string, string> = {
  manual: 'blue',
  hash: 'purple',
  round_robin: 'green',
  weighted_round_robin: 'amber',
  least_connections: 'cyan',
}

export const AllocationStrategyCard = ({
  strategies,
  activeStrategy,
  onActivate,
  onEdit,
  onDelete,
  isLoading = false,
}: AllocationStrategyCardProps) => {
  return (
    <div className="bg-surface-100 border border-default rounded-lg p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Settings className="w-5 h-5 text-foreground-light" />
          <h3 className="text-lg font-medium">Allocation Strategy</h3>
        </div>
      </div>

      <p className="text-sm text-foreground-light mb-6">
        Choose how new projects are assigned to database clusters
      </p>

      <div className="space-y-3">
        {strategies.map((strategy) => {
          const isActive = strategy.is_active
          const color = strategyTypeColors[strategy.strategy_type] || 'gray'

          return (
            <div
              key={strategy.id}
              className={`
                border rounded-lg p-4 transition-all
                ${isActive 
                  ? 'border-brand bg-brand-100/10' 
                  : 'border-default hover:border-stronger'
                }
              `}
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-2">
                    <h4 className="font-medium">{strategy.name}</h4>
                    <Badge color={color}>
                      {strategyTypeLabels[strategy.strategy_type]}
                    </Badge>
                    {isActive && (
                      <Badge color="brand" className="flex items-center gap-1">
                        <Check className="w-3 h-3" />
                        Active
                      </Badge>
                    )}
                  </div>
                  <p className="text-sm text-foreground-light">
                    {strategy.description}
                  </p>
                  {strategy.config && Object.keys(strategy.config).length > 0 && (
                    <div className="mt-2 text-xs text-foreground-lighter">
                      Config: {JSON.stringify(strategy.config)}
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-2 ml-4">
                  {!isActive && (
                    <Button
                      type="default"
                      size="tiny"
                      onClick={() => onActivate(strategy.name)}
                      disabled={isLoading}
                    >
                      Activate
                    </Button>
                  )}
                  <Button
                    type="text"
                    size="tiny"
                    icon={<Edit2 className="w-4 h-4" />}
                    onClick={() => onEdit(strategy)}
                    disabled={isLoading}
                  />
                  {!isActive && (
                    <Button
                      type="text"
                      size="tiny"
                      icon={<Trash2 className="w-4 h-4" />}
                      onClick={() => {
                        if (confirm(`Are you sure you want to delete "${strategy.name}"?`)) {
                          onDelete(strategy.name)
                        }
                      }}
                      disabled={isLoading}
                      className="text-red-900 hover:text-red-1000"
                    />
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {strategies.length === 0 && (
        <div className="text-center py-8 text-foreground-light">
          <Settings className="w-12 h-12 mx-auto mb-3 opacity-50" />
          <p>No allocation strategies configured</p>
        </div>
      )}
    </div>
  )
}

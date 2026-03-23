/**
 * Edit Strategy Modal Component
 * 
 * Modal for editing allocation strategy configuration
 * Validates: Requirements 7.2, 12.3
 */

import { useState } from 'react'
import { Modal, Button, Input, Toggle } from 'ui'
import type { AllocationStrategy } from './AllocationStrategyCard'

interface EditStrategyModalProps {
  strategy: AllocationStrategy
  visible: boolean
  onClose: () => void
  onSave: (updates: Partial<AllocationStrategy>) => Promise<void>
}

export const EditStrategyModal = ({
  strategy,
  visible,
  onClose,
  onSave,
}: EditStrategyModalProps) => {
  const [isLoading, setIsLoading] = useState(false)
  const [description, setDescription] = useState(strategy.description || '')
  const [isActive, setIsActive] = useState(strategy.is_active)
  const [configJson, setConfigJson] = useState(
    JSON.stringify(strategy.config || {}, null, 2)
  )
  const [configError, setConfigError] = useState<string | null>(null)

  const handleSave = async () => {
    // Validate JSON config
    let parsedConfig
    try {
      parsedConfig = JSON.parse(configJson)
    } catch (error) {
      setConfigError('Invalid JSON format')
      return
    }

    setIsLoading(true)
    try {
      await onSave({
        description,
        config: parsedConfig,
        is_active: isActive,
      })
      onClose()
    } catch (error) {
      console.error('Failed to save strategy:', error)
    } finally {
      setIsLoading(false)
    }
  }

  const handleConfigChange = (value: string) => {
    setConfigJson(value)
    setConfigError(null)
    
    // Try to parse to validate
    try {
      JSON.parse(value)
    } catch (error) {
      setConfigError('Invalid JSON')
    }
  }

  return (
    <Modal
      visible={visible}
      onCancel={onClose}
      header={`Edit Strategy: ${strategy.name}`}
      size="medium"
      customFooter={
        <div className="flex items-center justify-end gap-2">
          <Button type="default" onClick={onClose} disabled={isLoading}>
            Cancel
          </Button>
          <Button
            type="primary"
            onClick={handleSave}
            loading={isLoading}
            disabled={!!configError}
          >
            Save Changes
          </Button>
        </div>
      }
    >
      <div className="space-y-6 py-6 px-6">
        <div>
          <label className="text-sm font-medium mb-2 block">Description</label>
          <Input.TextArea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="Describe how this strategy works..."
          />
        </div>

        <div>
          <label className="text-sm font-medium mb-2 block">Configuration (JSON)</label>
          <Input.TextArea
            value={configJson}
            onChange={(e) => handleConfigChange(e.target.value)}
            rows={8}
            className="font-mono text-xs"
            placeholder='{"key": "value"}'
          />
          {configError && (
            <p className="text-xs text-red-900 mt-1">{configError}</p>
          )}
          <p className="text-xs text-foreground-light mt-1">
            Strategy-specific configuration in JSON format
          </p>
        </div>

        <div className="flex items-center justify-between py-2">
          <div>
            <label className="text-sm font-medium">Active Strategy</label>
            <p className="text-xs text-foreground-light">
              Set this as the active allocation strategy
            </p>
          </div>
          <Toggle
            checked={isActive}
            onChange={() => setIsActive(!isActive)}
          />
        </div>

        <div className="bg-surface-200 border border-default rounded p-4">
          <p className="text-xs text-foreground-light">
            <strong>Note:</strong> Only one strategy can be active at a time. 
            Activating this strategy will deactivate the current active strategy.
          </p>
        </div>
      </div>
    </Modal>
  )
}

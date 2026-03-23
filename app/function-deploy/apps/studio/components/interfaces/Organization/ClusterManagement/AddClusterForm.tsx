/**
 * Add Cluster Form Component
 * 
 * Form for registering a new database cluster
 * Validates: Requirements 12.3, 12.4, 12.5, 12.6
 */

import { useState } from 'react'
import { useDatabaseClusterAddMutation, ClusterAuthMethod } from 'data/database-clusters'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label_Shadcn_,
  RadioGroup_Shadcn_,
  RadioGroupItem_Shadcn_,
} from 'ui'
import { Input } from 'ui-patterns/DataInputs/Input'
import { toast } from 'sonner'

interface AddClusterFormProps {
  onClose: () => void
  onSuccess: () => void
}

interface FormData {
  identifier: string
  name: string
  host: string
  port: string
  admin_user: string
  auth_method: ClusterAuthMethod
  credential: string
  region: string
  weight: string
  max_databases: string
}

interface FormErrors {
  [key: string]: string
}

export const AddClusterForm = ({ onClose, onSuccess }: AddClusterFormProps) => {
  const [formData, setFormData] = useState<FormData>({
    identifier: '',
    name: '',
    host: '',
    port: '5432',
    admin_user: 'postgres',
    auth_method: 'password',
    credential: '',
    region: 'default',
    weight: '100',
    max_databases: '10000',
  })
  const [errors, setErrors] = useState<FormErrors>({})

  const addMutation = useDatabaseClusterAddMutation({
    onSuccess: () => {
      toast.success('Cluster added successfully')
      onSuccess()
    },
    onError: (error) => {
      toast.error(`Failed to add cluster: ${error.message}`)
    },
  })

  const handleChange = (field: keyof FormData, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }))
    // Clear error for this field when user starts typing
    if (errors[field]) {
      setErrors((prev) => {
        const newErrors = { ...prev }
        delete newErrors[field]
        return newErrors
      })
    }
  }

  const validateForm = (): boolean => {
    const newErrors: FormErrors = {}

    // Required fields
    if (!formData.identifier.trim()) {
      newErrors.identifier = 'Identifier is required'
    }
    if (!formData.name.trim()) {
      newErrors.name = 'Name is required'
    }
    if (!formData.host.trim()) {
      newErrors.host = 'Host is required'
    }
    if (!formData.admin_user.trim()) {
      newErrors.admin_user = 'Admin user is required'
    }

    // Credential validation based on auth_method
    if (!formData.credential.trim()) {
      if (formData.auth_method === 'password') {
        newErrors.credential = 'Password is required'
      } else {
        newErrors.credential = 'Secret reference is required'
      }
    }

    // Numeric validations
    const port = parseInt(formData.port)
    if (isNaN(port) || port < 1 || port > 65535) {
      newErrors.port = 'Port must be between 1 and 65535'
    }

    const weight = parseInt(formData.weight)
    if (isNaN(weight) || weight < 1) {
      newErrors.weight = 'Weight must be a positive number'
    }

    const maxDatabases = parseInt(formData.max_databases)
    if (isNaN(maxDatabases) || maxDatabases < 1) {
      newErrors.max_databases = 'Max databases must be a positive number'
    }

    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()

    if (!validateForm()) {
      return
    }

    addMutation.mutate({
      identifier: formData.identifier,
      name: formData.name,
      host: formData.host,
      port: parseInt(formData.port),
      admin_user: formData.admin_user,
      auth_method: formData.auth_method,
      credential: formData.credential,
      region: formData.region,
      weight: parseInt(formData.weight),
      max_databases: parseInt(formData.max_databases),
    })
  }

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader className="px-6 pt-6">
          <DialogTitle>Add Database Cluster</DialogTitle>
          <DialogDescription>
            Register a new database cluster for project allocation
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 px-6 pb-6">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label_Shadcn_ htmlFor="identifier">
                Identifier <span className="text-red-600">*</span>
              </Label_Shadcn_>
              <Input
                id="identifier"
                value={formData.identifier}
                onChange={(e) => handleChange('identifier', e.target.value)}
                placeholder="cluster-us-east-1a"
              />
              {errors.identifier && (
                <p className="text-sm text-red-600">{errors.identifier}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label_Shadcn_ htmlFor="name">
                Name <span className="text-red-600">*</span>
              </Label_Shadcn_>
              <Input
                id="name"
                value={formData.name}
                onChange={(e) => handleChange('name', e.target.value)}
                placeholder="US East 1A Production"
              />
              {errors.name && <p className="text-sm text-red-600">{errors.name}</p>}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label_Shadcn_ htmlFor="host">
                Host <span className="text-red-600">*</span>
              </Label_Shadcn_>
              <Input
                id="host"
                value={formData.host}
                onChange={(e) => handleChange('host', e.target.value)}
                placeholder="db1.example.com"
              />
              {errors.host && <p className="text-sm text-red-600">{errors.host}</p>}
            </div>

            <div className="space-y-2">
              <Label_Shadcn_ htmlFor="port">Port</Label_Shadcn_>
              <Input
                id="port"
                type="number"
                value={formData.port}
                onChange={(e) => handleChange('port', e.target.value)}
              />
              {errors.port && <p className="text-sm text-red-600">{errors.port}</p>}
            </div>
          </div>

          <div className="space-y-2">
            <Label_Shadcn_ htmlFor="admin_user">Admin User</Label_Shadcn_>
            <Input
              id="admin_user"
              value={formData.admin_user}
              onChange={(e) => handleChange('admin_user', e.target.value)}
            />
            {errors.admin_user && <p className="text-sm text-red-600">{errors.admin_user}</p>}
          </div>

          <div className="space-y-2">
            <Label_Shadcn_>
              Authentication Method <span className="text-red-600">*</span>
            </Label_Shadcn_>
            <RadioGroup_Shadcn_
              value={formData.auth_method}
              onValueChange={(value: string) => handleChange('auth_method', value as ClusterAuthMethod)}
            >
              <div className="flex items-center space-x-2">
                <RadioGroupItem_Shadcn_ value="password" id="auth-password" />
                <Label_Shadcn_ htmlFor="auth-password" className="font-normal cursor-pointer">
                  Password
                </Label_Shadcn_>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem_Shadcn_ value="secrets_manager" id="auth-secrets" />
                <Label_Shadcn_ htmlFor="auth-secrets" className="font-normal cursor-pointer">
                  Secrets Manager
                </Label_Shadcn_>
              </div>
            </RadioGroup_Shadcn_>
          </div>

          <div className="space-y-2">
            <Label_Shadcn_ htmlFor="credential">
              {formData.auth_method === 'password' ? 'Password' : 'Secret Reference (ARN or ID)'}
              <span className="text-red-600"> *</span>
            </Label_Shadcn_>
            <Input
              id="credential"
              type={formData.auth_method === 'password' ? 'password' : 'text'}
              value={formData.credential}
              onChange={(e) => handleChange('credential', e.target.value)}
              placeholder={
                formData.auth_method === 'password'
                  ? 'Enter admin password'
                  : 'arn:aws:secretsmanager:us-east-1:123456789:secret:db-cluster-1'
              }
            />
            {errors.credential && <p className="text-sm text-red-600">{errors.credential}</p>}
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label_Shadcn_ htmlFor="region">Region</Label_Shadcn_>
              <Input
                id="region"
                value={formData.region}
                onChange={(e) => handleChange('region', e.target.value)}
                placeholder="us-east-1"
              />
            </div>

            <div className="space-y-2">
              <Label_Shadcn_ htmlFor="weight">Weight</Label_Shadcn_>
              <Input
                id="weight"
                type="number"
                value={formData.weight}
                onChange={(e) => handleChange('weight', e.target.value)}
              />
              {errors.weight && <p className="text-sm text-red-600">{errors.weight}</p>}
            </div>

            <div className="space-y-2">
              <Label_Shadcn_ htmlFor="max_databases">Max Databases</Label_Shadcn_>
              <Input
                id="max_databases"
                type="number"
                value={formData.max_databases}
                onChange={(e) => handleChange('max_databases', e.target.value)}
              />
              {errors.max_databases && (
                <p className="text-sm text-red-600">{errors.max_databases}</p>
              )}
            </div>
          </div>

          <DialogFooter className="px-6 pb-6">
            <Button type="default" onClick={onClose} disabled={addMutation.isPending}>
              Cancel
            </Button>
            <Button type="primary" htmlType="submit" loading={addMutation.isPending}>
              Add Cluster
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

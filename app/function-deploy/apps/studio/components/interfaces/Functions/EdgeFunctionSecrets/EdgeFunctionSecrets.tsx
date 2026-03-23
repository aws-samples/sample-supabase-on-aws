import { PermissionAction } from '@supabase/shared-types/out/constants'
import { Search } from 'lucide-react'
import { useRef, useState, useMemo, useEffect } from 'react'
import { toast } from 'sonner'

import { useParams } from 'common'
import AlertError from 'components/ui/AlertError'
import NoPermission from 'components/ui/NoPermission'
import { useSecretsDeleteMutation } from 'data/secrets/secrets-delete-mutation'
import { useSecretsCreateMutation } from 'data/secrets/secrets-create-mutation'
import { useSecretsQuery } from 'data/secrets/secrets-query'
import { useAsyncCheckPermissions } from 'hooks/misc/useCheckPermissions'
import { handleErrorOnDelete, useQueryStateWithSelect } from 'hooks/misc/useQueryStateWithSelect'
import { Badge, Card, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from 'ui'
import { Input } from 'ui-patterns/DataInputs/Input'
import ConfirmationModal from 'ui-patterns/Dialogs/ConfirmationModal'
import { GenericSkeletonLoader } from 'ui-patterns/ShimmeringLoader'
import AddNewSecretForm from './AddNewSecretForm'
import EdgeFunctionSecret from './EdgeFunctionSecret'
import { EditSecretSheet } from './EditSecretSheet'
import { getKeys, useAPIKeysQuery } from 'data/api-keys/api-keys-query'
import { useProjectSettingsV2Query } from 'data/config/project-settings-v2-query'

// Define recommended secrets interface
interface RecommendedSecret {
  name: string
  value: string
  description: string
  isRecommended: boolean
  isSecret?: boolean
}

export const EdgeFunctionSecrets = () => {
  const { ref: projectRef } = useParams()
  const [searchString, setSearchString] = useState('')
  const [hasAutoCreated, setHasAutoCreated] = useState(false)

  // Track the ID being deleted to exclude it from error checking
  const deletingSecretNameRef = useRef<string | null>(null)

  const { can: canReadSecrets, isLoading: isLoadingSecretsPermissions } = useAsyncCheckPermissions(
    PermissionAction.FUNCTIONS_SECRET_READ,
    '*'
  )
  const { can: canUpdateSecrets } = useAsyncCheckPermissions(PermissionAction.SECRETS_WRITE, '*')

  const {
    data,
    error,
    isPending: isLoading,
    isSuccess,
    isError,
  } = useSecretsQuery(
    {
      projectRef: projectRef,
    },
    { enabled: canReadSecrets }
  )

  // Fetch API keys and project settings for recommended secrets
  const { data: apiKeys } = useAPIKeysQuery(
    { projectRef, reveal: true },
    { enabled: canReadSecrets }
  )
  const { data: settings } = useProjectSettingsV2Query({ 
    projectRef 
  }, { 
    enabled: canReadSecrets 
  })

  const { anonKey, serviceKey } = getKeys(apiKeys)

  // Build recommended secrets from environment and API keys
  const recommendedSecrets = useMemo((): RecommendedSecret[] => {
    const protocol = settings?.app_config?.protocol ?? 'http'
    const endpoint = settings?.app_config?.endpoint ?? 'localhost:8000'
    const projectUrl = `${protocol}://${endpoint}`
    
    const dbHost = settings?.db_host ?? process.env.POSTGRES_HOST ?? 'db'
    const dbPort = settings?.db_port ?? 5432
    const dbName = settings?.db_name ?? 'postgres'
    const dbUser = settings?.db_user ?? 'postgres'
    const databaseUrl = `postgresql://${dbUser}:[YOUR-PASSWORD]@${dbHost}:${dbPort}/${dbName}`

    return [
      {
        name: 'SUPABASE_URL',
        value: projectUrl,
        description: 'Your Supabase project URL',
        isRecommended: true,
      },
      {
        name: 'SUPABASE_ANON_KEY',
        value: anonKey?.api_key ?? process.env.SUPABASE_ANON_KEY ?? '',
        description: 'Public anonymous key for client-side operations',
        isRecommended: true,
      },
      {
        name: 'SUPABASE_SERVICE_ROLE_KEY',
        value: serviceKey?.api_key ?? process.env.SUPABASE_SERVICE_KEY ?? '',
        description: 'Service role key with admin privileges (keep secret!)',
        isRecommended: true,
        isSecret: true,
      },
      {
        name: 'SUPABASE_DB_URL',
        value: databaseUrl,
        description: 'Direct database connection URL',
        isRecommended: true,
      },
    ].filter((secret) => secret.value) // Only include secrets with values
  }, [settings, anonKey, serviceKey])

  const { mutate: createSecrets, isPending: isCreatingSecrets } = useSecretsCreateMutation({
    onSuccess: () => {
      // Silently create secrets without showing toast
      setHasAutoCreated(true)
    },
    onError: (error) => {
      console.error('Failed to auto-create recommended secrets:', error)
    },
  })

  // Auto-create recommended secrets when they don't exist
  useEffect(() => {
    if (
      !hasAutoCreated &&
      canUpdateSecrets &&
      data &&
      recommendedSecrets.length > 0 &&
      !isCreatingSecrets
    ) {
      const userSecretNames = new Set(data.map((s) => s.name))
      const missingSecrets = recommendedSecrets
        .filter((rec) => !userSecretNames.has(rec.name))
        .map((rec) => ({ name: rec.name, value: rec.value }))

      if (missingSecrets.length > 0) {
        createSecrets({ projectRef, secrets: missingSecrets })
      } else {
        setHasAutoCreated(true)
      }
    }
  }, [
    hasAutoCreated,
    canUpdateSecrets,
    data,
    recommendedSecrets,
    isCreatingSecrets,
    createSecrets,
    projectRef,
  ])

  // Merge recommended secrets with user secrets
  const allSecrets = useMemo(() => {
    const userSecrets = data ?? []
    
    // Mark user secrets that match recommended names
    const enhancedUserSecrets = userSecrets.map((secret) => {
      const matchingRecommended = recommendedSecrets.find((rec) => rec.name === secret.name)
      if (matchingRecommended) {
        return {
          ...secret,
          isRecommended: true,
          description: matchingRecommended.description,
          isSecret: matchingRecommended.isSecret,
        }
      }
      return secret
    })

    return enhancedUserSecrets
  }, [data, recommendedSecrets])

  const { setValue: setSelectedSecretToEdit, value: selectedSecretToEdit } =
    useQueryStateWithSelect({
      urlKey: 'edit',
      select: (secretName: string) =>
        secretName ? data?.find((secret) => secret.name === secretName) : undefined,
      enabled: !!data,
      onError: () => toast.error(`Secret not found`),
    })

  const { setValue: setSelectedSecretToDelete, value: selectedSecretToDelete } =
    useQueryStateWithSelect({
      urlKey: 'delete',
      select: (secretName: string) =>
        secretName ? data?.find((secret) => secret.name === secretName) : undefined,
      enabled: !!data,
      onError: (_error, selectedId) =>
        handleErrorOnDelete(deletingSecretNameRef, selectedId, `Secret not found`),
    })

  const { mutate: deleteSecret, isPending: isDeleting } = useSecretsDeleteMutation({
    onSuccess: (_, variables) => {
      toast.success(`Successfully deleted secret “${variables.secrets[0]}”`)
      setSelectedSecretToDelete(null)
    },
    onError: () => {
      deletingSecretNameRef.current = null
    },
  })

  const secrets =
    searchString.length > 0
      ? allSecrets.filter((secret) => secret.name.toLowerCase().includes(searchString.toLowerCase()))
      : allSecrets

  const headers = [
    <TableHead key="secret-name">Name</TableHead>,
    <TableHead key="secret-value" className="flex items-center gap-x-2">
      Digest <Badge variant="default">SHA256</Badge>
    </TableHead>,
    <TableHead key="secret-updated-at">Updated</TableHead>,
    <TableHead key="actions" />,
  ]

  const showLoadingState = isLoadingSecretsPermissions || (canReadSecrets && isLoading)

  return (
    <>
      {showLoadingState ? (
        <GenericSkeletonLoader />
      ) : !canReadSecrets ? (
        <NoPermission resourceText="view this project's edge function secrets" />
      ) : (
        <>
          {isError && <AlertError error={error} subject="Failed to retrieve project secrets" />}

          {isSuccess && (
            <>
              <div className="mb-10">
                {!canUpdateSecrets ? (
                  <NoPermission resourceText="manage this project's edge function secrets" />
                ) : (
                  <AddNewSecretForm />
                )}
              </div>
              {canUpdateSecrets && !canReadSecrets ? (
                <NoPermission resourceText="view this project's edge function secrets" />
              ) : canReadSecrets ? (
                <div className="space-y-4 mt-4">
                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-2">
                    <Input
                      size="small"
                      className="w-full md:w-80"
                      placeholder="Search for a secret"
                      value={searchString}
                      onChange={(e: any) => setSearchString(e.target.value)}
                      icon={<Search />}
                    />
                  </div>

                  <Card>
                    <Table>
                      <TableHeader>
                        <TableRow>{headers}</TableRow>
                      </TableHeader>
                      <TableBody>
                        {secrets.length > 0 ? (
                          secrets.map((secret) => (
                            <EdgeFunctionSecret
                              key={secret.name}
                              secret={secret}
                              onSelectEdit={() => setSelectedSecretToEdit(secret.name)}
                              onSelectDelete={() => setSelectedSecretToDelete(secret.name)}
                            />
                          ))
                        ) : secrets.length === 0 && searchString.length > 0 ? (
                          <TableRow className="[&>td]:hover:bg-inherit">
                            <TableCell colSpan={headers.length}>
                              <p className="text-sm text-foreground">No results found</p>
                              <p className="text-sm text-foreground-light">
                                Your search for "{searchString}" did not return any results
                              </p>
                            </TableCell>
                          </TableRow>
                        ) : (
                          <TableRow className="[&>td]:hover:bg-inherit">
                            <TableCell colSpan={headers.length}>
                              <p className="text-sm text-foreground">No secrets created</p>
                              <p className="text-sm text-foreground-light">
                                There are no secrets associated with your project yet
                              </p>
                            </TableCell>
                          </TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </Card>
                </div>
              ) : null}
            </>
          )}
        </>
      )}

      <EditSecretSheet
        secret={selectedSecretToEdit}
        visible={!!selectedSecretToEdit}
        onClose={() => setSelectedSecretToEdit(null)}
      />

      <ConfirmationModal
        variant="destructive"
        loading={isDeleting}
        visible={!!selectedSecretToDelete}
        confirmLabel="Delete secret"
        confirmLabelLoading="Deleting secret"
        title={`Delete secret “${selectedSecretToDelete?.name}”`}
        onCancel={() => setSelectedSecretToDelete(null)}
        onConfirm={() => {
          if (selectedSecretToDelete) {
            deletingSecretNameRef.current = selectedSecretToDelete.name
            deleteSecret({ projectRef, secrets: [selectedSecretToDelete.name] })
          }
        }}
      >
        <p className="text-sm">
          Ensure none of your edge functions are actively using this secret before deleting it. This
          action cannot be undone.
        </p>
      </ConfirmationModal>
    </>
  )
}

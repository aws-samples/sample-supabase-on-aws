/**
 * Secrets store interface for project secret management
 */

import type { ProjectSecretDocument } from '../../types/project-secret.js'

export interface SecretsStore {
  getProjectSecret(projectRef: string): Promise<ProjectSecretDocument | null>
  putProjectSecret(projectRef: string, doc: ProjectSecretDocument): Promise<void>
  deleteProjectSecret(projectRef: string): Promise<void>
}

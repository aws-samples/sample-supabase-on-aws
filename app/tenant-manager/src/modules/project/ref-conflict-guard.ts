/**
 * Guard that fails fast when a ref a caller wants to (re)use is still
 * occupied by residue from a previous teardown.
 *
 * Background: deprovisionProject does a "comprehensive teardown" (see
 * project.service.ts:505-650), but May 6 observation #7 flagged that the
 * teardown is best-effort and can leave stale rows in Secrets Manager,
 * Kong, or the platform DB when an external service is down at delete time.
 * Provisioning a new project with the same ref then silently overwrites or
 * collides. This guard turns that class of bug into an explicit 409.
 *
 * Order of checks goes from cheapest (DB lookup) to most expensive (Kong),
 * and the guard short-circuits on the first conflict found.
 *
 * If an integration call (Secrets Manager, Kong) itself fails, the
 * underlying error propagates — the guard does not convert a 5xx into a
 * 409, so the caller can decide whether to retry.
 */

import { findProjectByRef } from '../../db/repositories/project.repository.js'
import { getSecretsStore } from '../../integrations/secrets-manager/index.js'
import { projectConsumerExists } from '../../integrations/kong/kong-admin.client.js'
import { ConflictError } from '../../common/errors/index.js'

export const RefConflictReason = {
  EMPTY_REF: 'EMPTY_REF',
  PROJECT_RECORD: 'REF_PROJECT_RECORD_EXISTS',
  SECRETS_RESIDUE: 'REF_SECRETS_RESIDUE',
  KONG_CONSUMER_RESIDUE: 'REF_KONG_CONSUMER_RESIDUE',
} as const

export type RefConflictReasonCode = (typeof RefConflictReason)[keyof typeof RefConflictReason]

export async function assertRefAvailable(ref: string): Promise<void> {
  if (!ref || ref.trim().length === 0) {
    throw new ConflictError('Project ref must be a non-empty string', RefConflictReason.EMPTY_REF)
  }

  const existing = await findProjectByRef(ref)
  if (existing) {
    throw new ConflictError(
      `Project ref ${ref} already exists in the platform database`,
      RefConflictReason.PROJECT_RECORD,
    )
  }

  // AWS Secrets Manager soft-deletes (30-day recovery window). A re-created
  // ref will collide on the still-scheduled name, so treat that case as
  // residue too. The SDK throws InvalidRequestException with this exact
  // message when the secret is marked for deletion; we map it to a residue
  // conflict instead of letting it propagate as a 500.
  let staleSecret
  try {
    staleSecret = await getSecretsStore().getProjectSecret(ref)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('marked for deletion')) {
      throw new ConflictError(
        `Project ref ${ref} has a Secrets Manager document scheduled for deletion. ` +
          `Restore it (aws secretsmanager restore-secret) or pick a different ref.`,
        RefConflictReason.SECRETS_RESIDUE,
      )
    }
    throw err
  }
  if (staleSecret) {
    throw new ConflictError(
      `Project ref ${ref} has a stale Secrets Manager document from a prior incomplete teardown. ` +
        `Run cleanup or pick a different ref.`,
      RefConflictReason.SECRETS_RESIDUE,
    )
  }

  const staleConsumer = await projectConsumerExists(ref)
  if (staleConsumer) {
    throw new ConflictError(
      `Project ref ${ref} has a stale Kong consumer ${ref}--anon from a prior incomplete teardown. ` +
        `Run cleanup or pick a different ref.`,
      RefConflictReason.KONG_CONSUMER_RESIDUE,
    )
  }
}

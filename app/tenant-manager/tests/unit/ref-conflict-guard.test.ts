/**
 * Unit tests for the ref-reuse conflict guard.
 *
 * Background: deprovisionProject does a "comprehensive teardown" but the May 6
 * observation flagged "incomplete cleanup of external tenants and stale
 * references". If a previous teardown left a residue (Secrets Manager / Kong
 * consumer / platform DB row), provisioning a new project with the same ref
 * silently overwrites or collides. The guard makes that an explicit 409.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const findProjectByRef = vi.fn()
const getProjectSecret = vi.fn()
const projectConsumerExists = vi.fn()

vi.mock('../../src/db/repositories/project.repository.js', () => ({
  findProjectByRef: (...args: unknown[]) => findProjectByRef(...args),
}))

vi.mock('../../src/integrations/secrets-manager/index.js', () => ({
  getSecretsStore: () => ({
    getProjectSecret: (...args: unknown[]) => getProjectSecret(...args),
  }),
}))

vi.mock('../../src/integrations/kong/kong-admin.client.js', () => ({
  projectConsumerExists: (...args: unknown[]) => projectConsumerExists(...args),
}))

import { assertRefAvailable, RefConflictReason } from '../../src/modules/project/ref-conflict-guard.js'
import { ConflictError } from '../../src/common/errors/index.js'

describe('assertRefAvailable', () => {
  beforeEach(() => {
    findProjectByRef.mockReset()
    getProjectSecret.mockReset()
    projectConsumerExists.mockReset()
    findProjectByRef.mockResolvedValue(null)
    getProjectSecret.mockResolvedValue(null)
    projectConsumerExists.mockResolvedValue(false)
  })

  it('passes silently when no residue is detected', async () => {
    await expect(assertRefAvailable('clean-ref-123')).resolves.toBeUndefined()
  })

  it('throws ConflictError when an active project record already exists', async () => {
    findProjectByRef.mockResolvedValueOnce({ ref: 'dup', name: 'existing' })
    const err = await assertRefAvailable('dup').catch((e) => e)
    expect(err).toBeInstanceOf(ConflictError)
    expect((err as ConflictError).code).toBe(RefConflictReason.PROJECT_RECORD)
    expect((err as ConflictError).message).toMatch(/already exists/i)
  })

  it('throws ConflictError when a stale Secrets Manager doc remains', async () => {
    getProjectSecret.mockResolvedValueOnce({ project_ref: 'stale', api_keys: [], jwt_keys: [] })
    const err = await assertRefAvailable('stale').catch((e) => e)
    expect(err).toBeInstanceOf(ConflictError)
    expect((err as ConflictError).code).toBe(RefConflictReason.SECRETS_RESIDUE)
  })

  it('throws ConflictError when a stale Kong consumer remains', async () => {
    projectConsumerExists.mockResolvedValueOnce(true)
    const err = await assertRefAvailable('halfdead').catch((e) => e)
    expect(err).toBeInstanceOf(ConflictError)
    expect((err as ConflictError).code).toBe(RefConflictReason.KONG_CONSUMER_RESIDUE)
  })

  it('reports the project record before any residue checks (cheapest first)', async () => {
    findProjectByRef.mockResolvedValueOnce({ ref: 'dup' })
    getProjectSecret.mockResolvedValueOnce({ project_ref: 'dup', api_keys: [], jwt_keys: [] })
    projectConsumerExists.mockResolvedValueOnce(true)
    const err = await assertRefAvailable('dup').catch((e) => e)
    expect((err as ConflictError).code).toBe(RefConflictReason.PROJECT_RECORD)
    // External I/O should not run when the cheap DB check already failed
    expect(getProjectSecret).not.toHaveBeenCalled()
    expect(projectConsumerExists).not.toHaveBeenCalled()
  })

  it('does not surface external integration errors as conflicts', async () => {
    // If Secrets Manager throws (network blip etc.), we must NOT convert that
    // into a 409: we want to fail loudly with a 5xx so callers retry.
    getProjectSecret.mockRejectedValueOnce(new Error('SecretsManager unreachable'))
    await expect(assertRefAvailable('netflake')).rejects.toThrow('SecretsManager unreachable')
  })

  it('rejects empty refs at the boundary', async () => {
    await expect(assertRefAvailable('')).rejects.toBeInstanceOf(ConflictError)
  })

  it('treats AWS Secrets Manager soft-deleted secrets as residue, not 5xx', async () => {
    // Secrets Manager keeps deleted secrets for a 30-day recovery window.
    // The SDK throws InvalidRequestException("...marked for deletion") when
    // the same name is queried before recovery expires. Recreating the same
    // ref would still collide, so we map this to a SECRETS_RESIDUE conflict
    // rather than letting it bubble up as a 500.
    const sdkErr = new Error(
      "You can't perform this operation on the secret because it was marked for deletion."
    )
    getProjectSecret.mockRejectedValueOnce(sdkErr)
    const err = await assertRefAvailable('soft-deleted-ref').catch((e) => e)
    expect(err).toBeInstanceOf(ConflictError)
    expect(err.code).toBe(RefConflictReason.SECRETS_RESIDUE)
  })
})

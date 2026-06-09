/**
 * Kong Admin API client for consumer and credential management.
 * Registers consumers with key-auth credentials and ACL group memberships.
 * Ported from project-service/kong-admin.ts
 */

import { getEnv } from '../../config/index.js'

interface KongConsumer {
  id: string
  username: string
}

interface KongKeyAuthCredential {
  id: string
  key: string
}

interface KongAcl {
  id: string
  group: string
}

function getKongAdminUrl(): string {
  return getEnv().KONG_ADMIN_URL
}

async function kongRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const url = `${getKongAdminUrl()}${path}`
  const resp = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  })
  if (!resp.ok) {
    const body = await resp.text()
    throw new Error(`Kong Admin API ${options?.method || 'GET'} ${path}: ${resp.status} ${body}`)
  }
  return resp.json() as Promise<T>
}

async function ensureConsumer(username: string): Promise<KongConsumer> {
  try {
    return await kongRequest<KongConsumer>(`/consumers/${username}`)
  } catch {
    // Consumer doesn't exist, create it
  }
  return await kongRequest<KongConsumer>('/consumers', {
    method: 'POST',
    body: JSON.stringify({ username }),
  })
}

async function setKeyAuthCredential(consumerUsername: string, key: string): Promise<void> {
  const existing = await kongRequest<{ data: KongKeyAuthCredential[] }>(
    `/consumers/${consumerUsername}/key-auth`,
  )
  for (const cred of existing.data) {
    await fetch(`${getKongAdminUrl()}/consumers/${consumerUsername}/key-auth/${cred.id}`, {
      method: 'DELETE',
    })
  }
  await kongRequest(`/consumers/${consumerUsername}/key-auth`, {
    method: 'POST',
    body: JSON.stringify({ key }),
  })
}

async function setAclGroup(consumerUsername: string, group: string): Promise<void> {
  const existing = await kongRequest<{ data: KongAcl[] }>(
    `/consumers/${consumerUsername}/acls`,
  )
  if (existing.data.some((a) => a.group === group)) return
  await kongRequest(`/consumers/${consumerUsername}/acls`, {
    method: 'POST',
    body: JSON.stringify({ group }),
  })
}

/**
 * Register both anon and service_role consumers for a project.
 * Consumer naming: {projectRef}--anon, {projectRef}--service_role
 */
export async function registerProjectConsumers(
  projectRef: string,
  anonKey: string,
  serviceRoleKey: string,
): Promise<void> {
  const anonUsername = `${projectRef}--anon`
  await ensureConsumer(anonUsername)
  await setKeyAuthCredential(anonUsername, anonKey)
  await setAclGroup(anonUsername, 'anon')

  const srUsername = `${projectRef}--service_role`
  await ensureConsumer(srUsername)
  await setKeyAuthCredential(srUsername, serviceRoleKey)
  await setAclGroup(srUsername, 'admin')

  console.debug(`[kong-admin] Both consumers registered for project: ${projectRef}`)
}

/**
 * Delete Kong consumers for a project (for deprovision/rollback).
 */
export async function deleteProjectConsumers(projectRef: string): Promise<void> {
  for (const role of ['anon', 'service_role']) {
    const username = `${projectRef}--${role}`
    try {
      await fetch(`${getKongAdminUrl()}/consumers/${username}`, { method: 'DELETE' })
    } catch {
      // Ignore - consumer may not exist
    }
  }
}

/**
 * Whether the canonical {projectRef}--anon consumer is currently registered.
 * Used by the ref-reuse conflict guard to detect stale residue from a partial
 * teardown. 404 → false, 2xx → true, other status codes propagate as errors
 * so callers don't silently treat Kong outages as "no residue".
 */
export async function projectConsumerExists(projectRef: string): Promise<boolean> {
  const username = `${projectRef}--anon`
  const resp = await fetch(`${getKongAdminUrl()}/consumers/${username}`, { method: 'GET' })
  if (resp.status === 404) return false
  if (resp.ok) return true
  const body = await resp.text().catch(() => '')
  throw new Error(`Kong Admin GET /consumers/${username} unexpected status ${resp.status}: ${body}`)
}

/**
 * Ensures the platform-wide anonymous-public consumer exists.
 *
 * Used by the /functions/v1 key-auth fallback: when a request arrives without
 * a valid apikey, Kong attaches this consumer. The post-function plugin then
 * decides whether the request is permitted based on the target function's
 * verify_jwt flag (false → allow anonymous, true → 401).
 *
 * The consumer has NO key-auth credential (so it cannot be summoned by an
 * apikey) but IS in ACL group 'anon' so it passes the route's acl plugin.
 * Idempotent: safe to call on every boot.
 */
export async function ensureAnonymousPublicConsumer(): Promise<void> {
  await ensureConsumer('anonymous-public')
  await setAclGroup('anonymous-public', 'anon')
}

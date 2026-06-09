/**
 * Storage abstraction for self-hosted environments
 * Provides file-based storage with encryption for tokens and secrets
 */

import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import lockfile from 'proper-lockfile'
import type { AccessTokenRecord, ProjectSecretRecord, StorageConfig } from './types'

/**
 * Thrown when a project secrets file exists on disk but cannot be parsed or
 * decrypted. Callers must surface a 5xx instead of silently returning [].
 * Silent fall-through caused B1 (random data loss across ECS tasks).
 */
export class SecretsCorruptedError extends Error {
  constructor(filePath: string, cause: unknown) {
    super(`Secrets file at ${filePath} could not be read: ${(cause as Error)?.message ?? cause}`)
    this.name = 'SecretsCorruptedError'
    if (cause instanceof Error && cause.stack) {
      this.stack = cause.stack
    }
  }
}

/**
 * Thrown when the lockfile around a project secrets file cannot be acquired
 * within the configured retry budget. Callers should surface a 503.
 */
export class SecretsLockTimeoutError extends Error {
  constructor(filePath: string) {
    super(`Failed to acquire write lock on ${filePath} after retries`)
    this.name = 'SecretsLockTimeoutError'
  }
}

const LOCK_RETRY_OPTS = {
  retries: { retries: 8, factor: 1.5, minTimeout: 50, maxTimeout: 1500 },
  stale: 10_000,
  realpath: false,
}

/**
 * Default storage configuration for self-hosted environments
 */
const DEFAULT_STORAGE_CONFIG: StorageConfig = {
  accessTokensPath: '.supabase/access-tokens.json',
  secretsPath: process.env.SUPABASE_SECRETS_PATH || '.supabase/secrets',
  encryptionKey: process.env.SUPABASE_ENCRYPTION_KEY || 'default-key-change-in-production',
}

/**
 * Encrypts data using AES-256-GCM
 */
function encrypt(text: string, key: string): string {
  const algorithm = 'aes-256-gcm'
  const keyBuffer = crypto.scryptSync(key, 'salt', 32)
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv(algorithm, keyBuffer, iv)
  
  let encrypted = cipher.update(text, 'utf8', 'hex')
  encrypted += cipher.final('hex')
  const authTag = cipher.getAuthTag()
  
  return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted
}

/**
 * Decrypts data using AES-256-GCM
 */
function decrypt(encryptedData: string, key: string): string {
  const algorithm = 'aes-256-gcm'
  const keyBuffer = crypto.scryptSync(key, 'salt', 32)
  const parts = encryptedData.split(':')
  
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted data format')
  }
  
  const iv = Buffer.from(parts[0], 'hex')
  const authTag = Buffer.from(parts[1], 'hex')
  const encrypted = parts[2]
  
  const decipher = crypto.createDecipheriv(algorithm, keyBuffer, iv)
  decipher.setAuthTag(authTag)
  
  let decrypted = decipher.update(encrypted, 'hex', 'utf8')
  decrypted += decipher.final('utf8')
  
  return decrypted
}

/**
 * Ensures directory exists
 */
async function ensureDirectory(filePath: string): Promise<void> {
  const dir = path.dirname(filePath)
  try {
    await fs.access(dir)
  } catch {
    await fs.mkdir(dir, { recursive: true })
  }
}

/**
 * Ensures the target file exists so proper-lockfile can lock it.
 * Empty files are treated as "no secrets" by the loader.
 */
async function ensureFile(filePath: string): Promise<void> {
  try {
    await fs.access(filePath)
  } catch {
    const handle = await fs.open(filePath, 'a')
    await handle.close()
  }
}

/**
 * Access Tokens Storage
 */
export class AccessTokenStorage {
  private config: StorageConfig
  
  constructor(config: StorageConfig = DEFAULT_STORAGE_CONFIG) {
    this.config = config
  }
  
  /**
   * Loads all access tokens from storage
   */
  async loadTokens(): Promise<AccessTokenRecord[]> {
    try {
      await fs.access(this.config.accessTokensPath)
      const data = await fs.readFile(this.config.accessTokensPath, 'utf8')
      const encryptedTokens = JSON.parse(data)
      
      return encryptedTokens.map((encrypted: string) => {
        const decrypted = decrypt(encrypted, this.config.encryptionKey)
        return JSON.parse(decrypted) as AccessTokenRecord
      })
    } catch (error) {
      // File doesn't exist or is empty, return empty array
      return []
    }
  }
  
  /**
   * Saves access tokens to storage
   */
  async saveTokens(tokens: AccessTokenRecord[]): Promise<void> {
    await ensureDirectory(this.config.accessTokensPath)
    
    const encryptedTokens = tokens.map(token => {
      const serialized = JSON.stringify(token)
      return encrypt(serialized, this.config.encryptionKey)
    })
    
    await fs.writeFile(
      this.config.accessTokensPath,
      JSON.stringify(encryptedTokens, null, 2),
      'utf8'
    )
  }
  
  /**
   * Adds a new token to storage
   */
  async addToken(token: AccessTokenRecord): Promise<void> {
    const tokens = await this.loadTokens()
    tokens.push(token)
    await this.saveTokens(tokens)
  }
  
  /**
   * Removes a token from storage
   */
  async removeToken(tokenId: string): Promise<boolean> {
    const tokens = await this.loadTokens()
    const initialLength = tokens.length
    const filteredTokens = tokens.filter(token => token.id !== tokenId)
    
    if (filteredTokens.length < initialLength) {
      await this.saveTokens(filteredTokens)
      return true
    }
    
    return false
  }
  
  /**
   * Finds a token by ID
   */
  async findToken(tokenId: string): Promise<AccessTokenRecord | null> {
    const tokens = await this.loadTokens()
    return tokens.find(token => token.id === tokenId) || null
  }
}

/**
 * Project Secrets Storage
 */
export class ProjectSecretsStorage {
  private config: StorageConfig
  
  constructor(config: StorageConfig = DEFAULT_STORAGE_CONFIG) {
    this.config = config
  }
  
  /**
   * Gets the secrets file path for a project
   */
  private getProjectSecretsPath(projectRef: string): string {
    return path.join(this.config.secretsPath, `${projectRef}.json`)
  }
  
  /**
   * Loads secrets for a specific project.
   *
   * Returns [] only when the file legitimately does not exist (ENOENT).
   * Any other failure (decrypt error, malformed JSON, permission error)
   * surfaces as SecretsCorruptedError so callers can return 5xx instead
   * of silently dropping a tenant's saved secrets.
   */
  async loadProjectSecrets(projectRef: string): Promise<ProjectSecretRecord[]> {
    const filePath = this.getProjectSecretsPath(projectRef)

    let data: string
    try {
      data = await fs.readFile(filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return []
      }
      throw new SecretsCorruptedError(filePath, error)
    }

    try {
      const encryptedSecrets = JSON.parse(data)
      if (!Array.isArray(encryptedSecrets)) {
        throw new Error('expected an array of encrypted secrets')
      }
      return encryptedSecrets.map((encrypted: unknown) => {
        if (typeof encrypted !== 'string') {
          throw new Error('expected each entry to be an encrypted string')
        }
        const decrypted = decrypt(encrypted, this.config.encryptionKey)
        return JSON.parse(decrypted) as ProjectSecretRecord
      })
    } catch (error) {
      throw new SecretsCorruptedError(filePath, error)
    }
  }

  /**
   * Saves secrets atomically using temp-file + rename, guarded by a
   * proper-lockfile cooperative lock so concurrent writers across ECS
   * tasks (sharing the same EFS volume) cannot lose updates.
   */
  async saveProjectSecrets(projectRef: string, secrets: ProjectSecretRecord[]): Promise<void> {
    const filePath = this.getProjectSecretsPath(projectRef)
    await ensureDirectory(filePath)
    // Lockfile requires the target file to exist; touch it if missing.
    await ensureFile(filePath)

    let release: () => Promise<void>
    try {
      release = await lockfile.lock(filePath, LOCK_RETRY_OPTS)
    } catch (error) {
      throw new SecretsLockTimeoutError(filePath)
    }

    try {
      const encryptedSecrets = secrets.map((secret) => {
        const serialized = JSON.stringify(secret)
        return encrypt(serialized, this.config.encryptionKey)
      })
      const payload = JSON.stringify(encryptedSecrets, null, 2)
      const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`
      await fs.writeFile(tmpPath, payload, 'utf8')
      await fs.rename(tmpPath, filePath)
    } finally {
      await release()
    }
  }

  /**
   * Atomically reads-modifies-writes the project secrets file under a single
   * lock so concurrent writers cannot clobber each other's additions.
   */
  async updateProjectSecrets(
    projectRef: string,
    newSecrets: Array<{ name: string; value: string }>,
    createdBy: string = 'system'
  ): Promise<void> {
    await this.mutateUnderLock(projectRef, (existing) => {
      const now = new Date().toISOString()
      const secretsMap = new Map(existing.map((s) => [s.name, s]))
      newSecrets.forEach(({ name, value }) => {
        secretsMap.set(name, {
          name,
          value,
          updated_at: now,
          created_by: createdBy,
          project_ref: projectRef,
        })
      })
      return Array.from(secretsMap.values())
    })
  }

  /**
   * Atomically removes secrets under a single lock.
   */
  async removeProjectSecrets(projectRef: string, secretNames: string[]): Promise<void> {
    const remove = new Set(secretNames)
    await this.mutateUnderLock(projectRef, (existing) =>
      existing.filter((secret) => !remove.has(secret.name))
    )
  }

  /**
   * Acquires the project lock once for the read-modify-write cycle so two
   * concurrent updateProjectSecrets calls don't race between load and save.
   */
  private async mutateUnderLock(
    projectRef: string,
    transform: (existing: ProjectSecretRecord[]) => ProjectSecretRecord[]
  ): Promise<void> {
    const filePath = this.getProjectSecretsPath(projectRef)
    await ensureDirectory(filePath)
    await ensureFile(filePath)

    let release: () => Promise<void>
    try {
      release = await lockfile.lock(filePath, LOCK_RETRY_OPTS)
    } catch (error) {
      throw new SecretsLockTimeoutError(filePath)
    }

    try {
      const existing = await this.loadProjectSecretsUnsafe(filePath)
      const next = transform(existing)
      const encryptedSecrets = next.map((secret) => {
        const serialized = JSON.stringify(secret)
        return encrypt(serialized, this.config.encryptionKey)
      })
      const payload = JSON.stringify(encryptedSecrets, null, 2)
      const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`
      await fs.writeFile(tmpPath, payload, 'utf8')
      await fs.rename(tmpPath, filePath)
    } finally {
      await release()
    }
  }

  private async loadProjectSecretsUnsafe(filePath: string): Promise<ProjectSecretRecord[]> {
    let data: string
    try {
      data = await fs.readFile(filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return []
      }
      throw new SecretsCorruptedError(filePath, error)
    }
    if (data.trim().length === 0) {
      return []
    }
    try {
      const encryptedSecrets = JSON.parse(data)
      if (!Array.isArray(encryptedSecrets)) {
        throw new Error('expected an array of encrypted secrets')
      }
      return encryptedSecrets.map((encrypted: unknown) => {
        if (typeof encrypted !== 'string') {
          throw new Error('expected each entry to be an encrypted string')
        }
        const decrypted = decrypt(encrypted, this.config.encryptionKey)
        return JSON.parse(decrypted) as ProjectSecretRecord
      })
    } catch (error) {
      throw new SecretsCorruptedError(filePath, error)
    }
  }
  
  /**
   * Gets a specific secret by name
   */
  async getProjectSecret(projectRef: string, secretName: string): Promise<ProjectSecretRecord | null> {
    const secrets = await this.loadProjectSecrets(projectRef)
    return secrets.find(secret => secret.name === secretName) || null
  }
}

// Export singleton instances
export const accessTokenStorage = new AccessTokenStorage()
export const projectSecretsStorage = new ProjectSecretsStorage()
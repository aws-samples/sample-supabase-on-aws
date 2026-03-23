/**
 * Storage abstraction for self-hosted environments
 * Provides file-based storage with encryption for tokens and secrets
 */

import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import type { AccessTokenRecord, ProjectSecretRecord, StorageConfig } from './types'

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
   * Loads secrets for a specific project
   */
  async loadProjectSecrets(projectRef: string): Promise<ProjectSecretRecord[]> {
    const filePath = this.getProjectSecretsPath(projectRef)
    
    try {
      await fs.access(filePath)
      const data = await fs.readFile(filePath, 'utf8')
      const encryptedSecrets = JSON.parse(data)
      
      return encryptedSecrets.map((encrypted: string) => {
        const decrypted = decrypt(encrypted, this.config.encryptionKey)
        return JSON.parse(decrypted) as ProjectSecretRecord
      })
    } catch (error) {
      // File doesn't exist or is empty, return empty array
      return []
    }
  }
  
  /**
   * Saves secrets for a specific project
   */
  async saveProjectSecrets(projectRef: string, secrets: ProjectSecretRecord[]): Promise<void> {
    const filePath = this.getProjectSecretsPath(projectRef)
    await ensureDirectory(filePath)
    
    const encryptedSecrets = secrets.map(secret => {
      const serialized = JSON.stringify(secret)
      return encrypt(serialized, this.config.encryptionKey)
    })
    
    await fs.writeFile(
      filePath,
      JSON.stringify(encryptedSecrets, null, 2),
      'utf8'
    )
  }
  
  /**
   * Updates or creates secrets for a project
   */
  async updateProjectSecrets(
    projectRef: string,
    newSecrets: Array<{ name: string; value: string }>,
    createdBy: string = 'system'
  ): Promise<void> {
    const existingSecrets = await this.loadProjectSecrets(projectRef)
    const now = new Date().toISOString()
    
    // Create a map of existing secrets for quick lookup
    const secretsMap = new Map(existingSecrets.map(s => [s.name, s]))
    
    // Update or add new secrets
    newSecrets.forEach(({ name, value }) => {
      secretsMap.set(name, {
        name,
        value,
        updated_at: now,
        created_by: createdBy,
        project_ref: projectRef,
      })
    })
    
    await this.saveProjectSecrets(projectRef, Array.from(secretsMap.values()))
  }
  
  /**
   * Removes secrets from a project
   */
  async removeProjectSecrets(projectRef: string, secretNames: string[]): Promise<void> {
    const existingSecrets = await this.loadProjectSecrets(projectRef)
    const filteredSecrets = existingSecrets.filter(
      secret => !secretNames.includes(secret.name)
    )
    
    await this.saveProjectSecrets(projectRef, filteredSecrets)
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
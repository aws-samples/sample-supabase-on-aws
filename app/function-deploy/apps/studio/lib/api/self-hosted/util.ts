import crypto from 'crypto-js'
import { IS_PLATFORM } from '../../constants'
import {
  getEncryptionKey,
  POSTGRES_DATABASE,
  POSTGRES_HOST,
  POSTGRES_PASSWORD,
  POSTGRES_PORT,
  POSTGRES_USER_READ_WRITE,
  POSTGRES_USER_READ_ONLY,
} from './constants'

/**
 * Asserts that the current environment is self-hosted.
 */
export function assertSelfHosted() {
  if (IS_PLATFORM) {
    throw new Error('This function can only be called in self-hosted environments')
  }
}

export function encryptString(stringToEncrypt: string): string {
  return crypto.AES.encrypt(stringToEncrypt, getEncryptionKey()).toString()
}

export function getConnectionString({ 
  readOnly,
  databaseName,
}: { 
  readOnly: boolean
  databaseName?: string
}) {
  const postgresUser = readOnly ? POSTGRES_USER_READ_ONLY : POSTGRES_USER_READ_WRITE
  const database = databaseName || POSTGRES_DATABASE
  
  // For pg-meta access, use internal Docker network host and port
  // pg-meta runs inside Docker and needs to connect to 'db:5432'
  const host = POSTGRES_HOST === 'localhost' ? 'db' : POSTGRES_HOST
  const port = POSTGRES_PORT === '54322' || POSTGRES_PORT === 54322 ? 5432 : POSTGRES_PORT

  return `postgresql://${postgresUser}:${POSTGRES_PASSWORD}@${host}:${port}/${database}`
}

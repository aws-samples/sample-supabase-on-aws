/**
 * Kysely migration executor
 */

import { Migrator, FileMigrationProvider } from 'kysely'
import { promises as fs } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { getManagementDb } from './connection.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * Create a migrator instance
 */
function createMigrator(): Migrator {
  const db = getManagementDb()
  return new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: path.join(__dirname, 'migrations'),
    }),
    migrationTableSchema: '_tenant',
  })
}

/**
 * Run all pending migrations
 */
export async function migrateUp(): Promise<void> {
  const migrator = createMigrator()
  const { error, results } = await migrator.migrateToLatest()

  if (results) {
    for (const result of results) {
      if (result.status === 'Success') {
        console.debug(`Migration "${result.migrationName}" applied successfully`)
      } else if (result.status === 'Error') {
        console.error(`Migration "${result.migrationName}" failed`)
      }
    }
  }

  if (error) {
    console.error('Migration failed:', error)
    throw error
  }
}

/**
 * Rollback the last migration
 */
export async function migrateDown(): Promise<void> {
  const migrator = createMigrator()
  const { error, results } = await migrator.migrateDown()

  if (results) {
    for (const result of results) {
      if (result.status === 'Success') {
        console.debug(`Migration "${result.migrationName}" rolled back successfully`)
      } else if (result.status === 'Error') {
        console.error(`Migration "${result.migrationName}" rollback failed`)
      }
    }
  }

  if (error) {
    console.error('Migration rollback failed:', error)
    throw error
  }
}

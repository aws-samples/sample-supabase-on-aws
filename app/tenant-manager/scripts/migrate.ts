/**
 * Database migration CLI
 * Usage: pnpm migrate:up | pnpm migrate:down
 */

import 'dotenv/config'
import { migrateUp, migrateDown } from '../src/db/migrator.js'
import { closeAllPools } from '../src/db/connection.js'

const command = process.argv[2]

async function main() {
  try {
    switch (command) {
      case 'up':
        console.log('Running migrations...')
        await migrateUp()
        console.log('Migrations completed successfully')
        break
      case 'down':
        console.log('Rolling back last migration...')
        await migrateDown()
        console.log('Rollback completed successfully')
        break
      default:
        console.error('Usage: migrate.ts <up|down>')
        process.exit(1)
    }
  } catch (error) {
    console.error('Migration error:', error)
    process.exit(1)
  } finally {
    await closeAllPools()
  }
}

main()

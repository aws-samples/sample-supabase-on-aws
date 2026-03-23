/**
 * Demo script to verify database management core module functionality
 * This file demonstrates the usage of the database management utilities
 */

import {
  validateDatabaseName,
  isValidDatabaseName,
  sanitizeDatabaseName,
  generateDatabaseName,
  DatabaseNamingError,
} from './database-naming'

import { generateConnectionString, parseConnectionString } from './connection-string'

import {
  createDatabase,
  databaseExists,
  listDatabases,
  deleteDatabase,
  getTemplateDatabaseName,
  DatabaseErrorCode,
} from './database-manager'

// Demo 1: Database naming utilities
console.log('=== Database Naming Utilities Demo ===')

// Validate database names
console.log('Valid name "mydb":', isValidDatabaseName('mydb')) // true
console.log('Valid name "my-db":', isValidDatabaseName('my-db')) // false
console.log('Valid name "postgres":', isValidDatabaseName('postgres')) // false (reserved)

// Sanitize project names
console.log('Sanitize "My Project #1":', sanitizeDatabaseName('My Project #1')) // my_project_1
console.log('Sanitize "123test":', sanitizeDatabaseName('123test')) // db_123test

// Generate unique database names
console.log('Generate from "test project":', generateDatabaseName('test project'))
console.log('Generate from "test project":', generateDatabaseName('test project'))
// Both will be different due to timestamp

// Demo 2: Connection string generation
console.log('\n=== Connection String Generation Demo ===')

const connStr = generateConnectionString({
  databaseName: 'my_project_db',
  readOnly: false,
})
console.log('Connection string:', connStr)

const parsed = parseConnectionString(connStr)
console.log('Parsed:', parsed)

// Demo 3: Database operations (async - would need actual database connection)
console.log('\n=== Database Operations Demo ===')
console.log('Template database name:', getTemplateDatabaseName())

// Example usage (commented out as it requires actual database):
/*
async function demoDbOperations() {
  // Check if database exists
  const exists = await databaseExists('test_db')
  console.log('Database exists:', exists)

  // Create database
  const createResult = await createDatabase({
    name: 'my_new_db',
    template: 'postgres',
  })
  
  if (createResult.error) {
    console.error('Create failed:', createResult.error.message)
  } else {
    console.log('Database created successfully')
  }

  // List all databases
  const listResult = await listDatabases()
  if (listResult.data) {
    console.log('Databases:', listResult.data.map(db => db.name))
  }

  // Delete database
  const deleteResult = await deleteDatabase('my_new_db')
  if (deleteResult.error) {
    console.error('Delete failed:', deleteResult.error.message)
  } else {
    console.log('Database deleted successfully')
  }
}
*/

export {}

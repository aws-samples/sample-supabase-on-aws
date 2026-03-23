/**
 * Demonstration script for the Credential Migration System
 * 
 * This script shows how to use the credential migration system to:
 * 1. Detect projects with missing credentials
 * 2. Generate secure project-specific credentials
 * 3. Migrate credentials for legacy projects
 * 4. Get migration statistics
 */

import { getCredentialMigrationManager } from './credential-migration-manager'

/**
 * Demonstrates the credential migration system functionality
 */
export async function demonstrateCredentialMigration() {
  console.log('=== Credential Migration System Demo ===\n')

  const migrationManager = getCredentialMigrationManager()

  // 1. Generate credentials for a new project
  console.log('1. Generating credentials for a new project...')
  const projectRef = 'demo-project-2024'
  const credentialsResult = migrationManager.generateProjectCredentials(projectRef)

  if (credentialsResult.error) {
    console.error('❌ Failed to generate credentials:', credentialsResult.error.message)
    return
  }

  console.log('✅ Generated credentials:')
  console.log(`   Username: ${credentialsResult.data!.user}`)
  console.log(`   Password Hash: ${credentialsResult.data!.passwordHash?.substring(0, 20)}...`)
  console.log(`   Complete: ${credentialsResult.data!.isComplete}`)
  console.log()

  // 2. Generate credentials with custom options
  console.log('2. Generating credentials with custom options...')
  const customOptions = {
    userPrefix: 'custom_',
    userSuffix: '_db',
    passwordLength: 16,
    includeSpecialChars: false,
    excludeSimilarChars: true
  }

  const customCredentialsResult = migrationManager.generateProjectCredentials(
    'custom-project',
    customOptions
  )

  if (customCredentialsResult.error) {
    console.error('❌ Failed to generate custom credentials:', customCredentialsResult.error.message)
    return
  }

  console.log('✅ Generated custom credentials:')
  console.log(`   Username: ${customCredentialsResult.data!.user}`)
  console.log(`   Password Hash: ${customCredentialsResult.data!.passwordHash?.substring(0, 20)}...`)
  console.log()

  // 3. Detect projects with missing credentials (simulated)
  console.log('3. Detecting projects with missing credentials...')
  const detectionResult = await migrationManager.detectProjectsWithMissingCredentials()

  if (detectionResult.error) {
    console.error('❌ Failed to detect projects:', detectionResult.error.message)
    return
  }

  console.log(`✅ Found ${detectionResult.data!.length} projects with missing credentials`)
  if (detectionResult.data!.length > 0) {
    console.log('   Projects:', detectionResult.data!.join(', '))
  }
  console.log()

  // 4. Get migration statistics
  console.log('4. Getting migration statistics...')
  const statsResult = await migrationManager.getMigrationStats()

  if (statsResult.error) {
    console.error('❌ Failed to get statistics:', statsResult.error.message)
    return
  }

  const stats = statsResult.data!
  console.log('✅ Migration Statistics:')
  console.log(`   Total Projects: ${stats.totalProjects}`)
  console.log(`   Projects with Missing Credentials: ${stats.projectsWithMissingCredentials}`)
  console.log(`   Projects with Missing User: ${stats.projectsWithMissingUser}`)
  console.log(`   Projects with Missing Password: ${stats.projectsWithMissingPassword}`)
  console.log(`   Projects with Both Missing: ${stats.projectsWithBothMissing}`)
  console.log(`   Complete Projects: ${stats.projectsComplete}`)
  console.log()

  // 5. Simulate a dry run migration
  console.log('5. Performing dry run migration...')
  const dryRunResult = await migrationManager.migrateAllProjectCredentials({}, true)

  if (dryRunResult.error) {
    console.error('❌ Failed to perform dry run:', dryRunResult.error.message)
    return
  }

  const dryRun = dryRunResult.data!
  console.log('✅ Dry Run Results:')
  console.log(`   Total Projects: ${dryRun.totalProjects}`)
  console.log(`   Would Migrate: ${dryRun.summary.projectsWithMissingCredentials}`)
  console.log(`   Already Complete: ${dryRun.summary.projectsAlreadyComplete}`)
  console.log(`   Successful Simulations: ${dryRun.successfulMigrations}`)
  console.log(`   Failed Simulations: ${dryRun.failedMigrations}`)
  console.log()

  // 6. Demonstrate credential validation
  console.log('6. Validating existing credentials...')
  if (detectionResult.data!.length > 0) {
    const projectToValidate = detectionResult.data![0]
    const validationResult = await migrationManager.validateExistingCredentials(projectToValidate)

    if (validationResult.error) {
      console.error('❌ Failed to validate credentials:', validationResult.error.message)
    } else {
      const validation = validationResult.data!
      console.log(`✅ Validation for project ${projectToValidate}:`)
      console.log(`   Valid: ${validation.isValid}`)
      console.log(`   User Errors: ${validation.userValidation.errors.length}`)
      console.log(`   Password Errors: ${validation.passwordValidation.errors.length}`)
      console.log(`   Overall Errors: ${validation.overallErrors.length}`)
    }
  } else {
    console.log('   No projects with missing credentials to validate')
  }
  console.log()

  console.log('=== Demo Complete ===')
}

/**
 * Example usage of individual migration functions
 */
export async function exampleMigrationUsage() {
  const migrationManager = getCredentialMigrationManager()

  try {
    // Generate credentials for a specific project
    const projectRef = 'example-project'
    const credentials = migrationManager.generateProjectCredentials(projectRef, {
      userPrefix: 'proj_',
      passwordLength: 20,
      includeSpecialChars: true
    })

    if (credentials.error) {
      throw credentials.error
    }

    console.log('Generated credentials:', {
      user: credentials.data!.user,
      hasPassword: !!credentials.data!.passwordHash,
      isComplete: credentials.data!.isComplete
    })

    // Migrate a single project (would need actual project in store)
    // const migrationResult = await migrationManager.migrateProjectCredentials(projectRef)
    
    // Get statistics
    const stats = await migrationManager.getMigrationStats()
    if (stats.data) {
      console.log('Current migration stats:', stats.data)
    }

  } catch (error) {
    console.error('Migration example failed:', error)
  }
}

// Export for use in other modules
export { getCredentialMigrationManager } from './credential-migration-manager'
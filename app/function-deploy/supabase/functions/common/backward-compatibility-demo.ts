/**
 * Demonstration of Backward Compatibility Layer
 * Shows how legacy and multi-level functions coexist
 */

import {
  BackwardCompatibilityManager,
  UrlPatternCompatibility,
  FunctionStructureValidator
} from './backward-compatibility.ts'

console.log('🚀 Backward Compatibility Layer Demo\n')

// Initialize the compatibility manager
const manager = new BackwardCompatibilityManager({
  preserveLegacyUrls: true,
  supportMixedStructures: true,
  enablePathMigration: false
})

const urlCompatibility = new UrlPatternCompatibility(manager)

console.log('📁 Setting up mixed function structure...')

// Register legacy functions (existing single-level functions)
console.log('  ✅ Registering legacy functions:')
manager.registerLegacyFunction('hello-world', 'hello-world')
manager.registerLegacyFunction('auth-login', 'auth-login')
manager.registerLegacyFunction('user-profile', 'user-profile')
console.log('    - hello-world (legacy)')
console.log('    - auth-login (legacy)')
console.log('    - user-profile (legacy)')

// Register multi-level functions (new nested structure)
console.log('  ✅ Registering multi-level functions:')
manager.registerMultiLevelFunction('api-users', 'api/users')
manager.registerMultiLevelFunction('api-auth-login', 'api/auth/login')
manager.registerMultiLevelFunction('api-auth-register', 'api/auth/register')
manager.registerMultiLevelFunction('utils-db-connection', 'utils/database/connection')
manager.registerMultiLevelFunction('utils-validation', 'utils/validation/schema')
console.log('    - api/users (multi-level)')
console.log('    - api/auth/login (multi-level)')
console.log('    - api/auth/register (multi-level)')
console.log('    - utils/database/connection (multi-level)')
console.log('    - utils/validation/schema (multi-level)')

console.log('\n📊 Function Registry Statistics:')
const stats = manager.getCompatibilityStats()
console.log(`  Total Functions: ${stats.totalFunctions}`)
console.log(`  Legacy Functions: ${stats.legacyFunctions}`)
console.log(`  Multi-Level Functions: ${stats.multiLevelFunctions}`)
console.log(`  Path Mappings: ${stats.pathMappings}`)

console.log('\n🔗 Testing URL Resolution:')

// Test various URL patterns
const testUrls = [
  // Legacy function URLs (should work as before)
  'http://localhost:8000/hello-world',
  'http://localhost:8000/auth-login',
  'http://localhost:8000/user-profile',
  
  // Multi-level function URLs (new functionality)
  'http://localhost:8000/api/users',
  'http://localhost:8000/api/auth/login',
  'http://localhost:8000/api/auth/register',
  'http://localhost:8000/utils/database/connection',
  'http://localhost:8000/utils/validation/schema',
  
  // Test edge cases
  'http://localhost:8000/non-existent',
  'http://localhost:8000/../etc/passwd',
  'http://localhost:8000/malicious<script>'
]

for (const url of testUrls) {
  const result = urlCompatibility.processRequestUrl(url)
  const urlPath = new URL(url).pathname
  
  if (result.functionPath) {
    const type = result.isLegacyUrl ? '🏛️  Legacy' : '🏗️  Multi-level'
    console.log(`  ✅ ${urlPath} → ${result.functionPath} (${type})`)
  } else {
    console.log(`  ❌ ${urlPath} → Not found/Invalid`)
  }
}

console.log('\n🛡️  Security Validation:')

// Test security features
const maliciousPaths = [
  '../../../etc/passwd',
  '~/secrets',
  '/absolute/path',
  'func<script>',
  'func|pipe',
  'func\x00null'
]

console.log('  Testing malicious paths:')
for (const path of maliciousPaths) {
  const resolved = manager.resolveFunctionPath(path)
  console.log(`    ${path} → ${resolved ? '⚠️  ALLOWED' : '✅ BLOCKED'}`)
}

console.log('\n🔄 Path Migration Demo:')

// Create a manager with migration enabled
const migrationManager = new BackwardCompatibilityManager({
  preserveLegacyUrls: true,
  supportMixedStructures: true,
  enablePathMigration: true
})

// Register a legacy function
migrationManager.registerLegacyFunction('old-auth', 'old-auth')
console.log('  📝 Registered legacy function: old-auth')
console.log(`  🏛️  Is legacy: ${migrationManager.isLegacyFunction('old-auth')}`)

// Migrate to new structure
const migrated = migrationManager.migrateLegacyPath('old-auth', 'api/auth/legacy')
console.log(`  🔄 Migration result: ${migrated ? 'SUCCESS' : 'FAILED'}`)
console.log(`  🏗️  Is legacy after migration: ${migrationManager.isLegacyFunction('old-auth')}`)

// Test both old and new paths work
console.log('  🔗 Testing post-migration access:')
console.log(`    /old-auth → ${migrationManager.resolveFunctionPath('/old-auth')}`)
console.log(`    /api/auth/legacy → ${migrationManager.resolveFunctionPath('/api/auth/legacy')}`)

console.log('\n✅ Structure Validation:')

// Validate the mixed structure
const allFunctions = manager.getAllFunctions()
const validation = FunctionStructureValidator.validateMixedStructures(allFunctions)

console.log(`  Structure is valid: ${validation.isValid ? '✅ YES' : '❌ NO'}`)
if (validation.conflicts.length > 0) {
  console.log('  Conflicts:')
  validation.conflicts.forEach(conflict => console.log(`    ⚠️  ${conflict}`))
}
if (validation.recommendations.length > 0) {
  console.log('  Recommendations:')
  validation.recommendations.forEach(rec => console.log(`    💡 ${rec}`))
}

console.log('\n🎯 URL Pattern Generation:')

// Show all possible URL patterns for each function
console.log('  Available URL patterns:')
for (const func of allFunctions) {
  const patterns = urlCompatibility.generateUrlPatterns(func.path)
  const type = func.isLegacy ? '🏛️ ' : '🏗️ '
  console.log(`    ${type}${func.path}:`)
  patterns.forEach(pattern => console.log(`      ${pattern}`))
}

console.log('\n🎉 Demo Complete!')
console.log('\nKey Benefits:')
console.log('  ✅ Legacy functions continue to work unchanged')
console.log('  ✅ New multi-level structure is fully supported')
console.log('  ✅ Mixed structures can coexist safely')
console.log('  ✅ Security validation prevents malicious paths')
console.log('  ✅ Migration path available for gradual updates')
console.log('  ✅ URL patterns preserved for backward compatibility')

export { manager, urlCompatibility }
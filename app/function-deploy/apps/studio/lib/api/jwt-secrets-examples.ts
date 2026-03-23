/**
 * JWT Secrets API Usage Examples
 * 
 * This file contains practical examples of how to use the JWT Secrets HTTP API endpoints.
 */

import { JwtSecretsClient } from './jwt-secrets-client'

/**
 * Example 1: Basic JWT Secret Information Retrieval
 */
export async function exampleBasicJwtSecretInfo() {
  const authToken = 'your-auth-token-here'
  const baseUrl = 'https://your-supabase-studio.com'
  
  const client = new JwtSecretsClient(baseUrl, authToken)
  
  try {
    // Get global JWT secret information
    console.log('=== Global JWT Secret Information ===')
    const globalSecret = await client.getGlobalJwtSecret()
    
    console.log('Global JWT configured:', globalSecret.global_jwt_secret.configured)
    console.log('Secret length:', globalSecret.global_jwt_secret.length)
    console.log('Masked value:', globalSecret.global_jwt_secret.masked_value)
    console.log('Environment variables:', globalSecret.global_jwt_secret.environment_variables)
    console.log('Supabase URL:', globalSecret.supabase_url)
    
    // Get project-specific JWT secret information
    console.log('\n=== Project JWT Secret Information ===')
    const projectRef = 'my-project-ref'
    const projectSecret = await client.getProjectJwtSecret(projectRef)
    
    console.log('Project ref:', projectSecret.project_ref)
    console.log('Active secret source:', projectSecret.active_jwt_secret?.source)
    console.log('Active secret masked:', projectSecret.active_jwt_secret?.masked_value)
    
    console.log('\nAvailable sources:')
    Object.entries(projectSecret.available_sources).forEach(([source, info]) => {
      console.log(`  ${source}:`, {
        configured: info.configured,
        length: info.length,
        masked: info.masked_value
      })
    })
    
    console.log('Priority order:', projectSecret.priority_order)
    console.log('User access:', projectSecret.user_access)
    
  } catch (error) {
    console.error('Error retrieving JWT secret information:', error)
  }
}

/**
 * Example 2: JWT Token Verification
 */
export async function exampleJwtTokenVerification() {
  const authToken = 'your-auth-token-here'
  const baseUrl = 'https://your-supabase-studio.com'
  const projectRef = 'my-project-ref'
  
  // Example JWT token (this would be a real token in practice)
  const jwtToken = '<your-jwt-token>'
  
  const client = new JwtSecretsClient(baseUrl, authToken)
  
  try {
    console.log('=== JWT Token Verification ===')
    const verification = await client.verifyJwtToken(projectRef, jwtToken)
    
    console.log('Project ref:', verification.project_ref)
    console.log('Token is valid:', verification.verification_result.is_valid)
    
    if (verification.verification_result.is_valid) {
      console.log('Secret source used:', verification.verification_result.secret_source)
      console.log('Decoded payload:', verification.verification_result.decoded_payload)
      console.log('Token info:', verification.verification_result.token_info)
    } else {
      console.log('Verification error:', verification.verification_result.error)
      console.log('Error details:', verification.verification_result.details)
      console.log('Attempted sources:', verification.verification_result.attempted_sources)
    }
    
    console.log('Verification metadata:', verification.verification_metadata)
    
  } catch (error) {
    console.error('Error verifying JWT token:', error)
  }
}

/**
 * Example 3: JWT Secret Reveal (DANGEROUS - Use with caution)
 */
export async function exampleJwtSecretReveal() {
  const authToken = 'your-auth-token-here'
  const baseUrl = 'https://your-supabase-studio.com'
  const projectRef = 'my-project-ref'
  
  const client = new JwtSecretsClient(baseUrl, authToken)
  
  try {
    console.log('=== JWT Secret Reveal (DANGEROUS) ===')
    console.log('WARNING: This will reveal the actual JWT secret value!')
    
    const purpose = 'Development testing and debugging JWT token verification issues'
    const revealResponse = await client.revealProjectJwtSecret(projectRef, purpose)
    
    console.log('Project ref:', revealResponse.project_ref)
    console.log('Revealed secret:', revealResponse.revealed_secret.value)
    console.log('Secret source:', revealResponse.revealed_secret.source)
    console.log('Secret length:', revealResponse.revealed_secret.length)
    console.log('Algorithm:', revealResponse.revealed_secret.algorithm)
    
    console.log('\nSecurity warning:', revealResponse.security_warning)
    console.log('Access log:', revealResponse.access_log)
    console.log('Usage instructions:', revealResponse.usage_instructions)
    
  } catch (error) {
    console.error('Error revealing JWT secret:', error)
    
    if (error instanceof Error) {
      if (error.message.includes('JWT secret reveal is disabled')) {
        console.log('Tip: Set ALLOW_JWT_SECRET_REVEAL=true environment variable to enable this feature')
      }
      if (error.message.includes('Only project owners')) {
        console.log('Tip: Only project owners can reveal JWT secrets')
      }
    }
  }
}

/**
 * Example 4: Complete JWT Secret Analysis
 */
export async function exampleCompleteJwtSecretAnalysis() {
  const authToken = 'your-auth-token-here'
  const baseUrl = 'https://your-supabase-studio.com'
  const projectRef = 'my-project-ref'
  
  const client = new JwtSecretsClient(baseUrl, authToken)
  
  try {
    console.log('=== Complete JWT Secret Analysis ===')
    
    // Step 1: Get global configuration
    const globalSecret = await client.getGlobalJwtSecret()
    console.log('1. Global JWT Secret Analysis:')
    console.log('   - Configured:', globalSecret.global_jwt_secret.configured)
    console.log('   - Length:', globalSecret.global_jwt_secret.length)
    console.log('   - Source:', globalSecret.global_jwt_secret.source)
    
    // Step 2: Get project-specific configuration
    const projectSecret = await client.getProjectJwtSecret(projectRef)
    console.log('\n2. Project JWT Secret Analysis:')
    console.log('   - Active source:', projectSecret.active_jwt_secret?.source)
    console.log('   - Available sources:', Object.keys(projectSecret.available_sources))
    
    // Step 3: Analyze each available source
    console.log('\n3. Source-by-Source Analysis:')
    Object.entries(projectSecret.available_sources).forEach(([source, info]) => {
      console.log(`   ${source}:`)
      console.log(`     - Configured: ${info.configured}`)
      console.log(`     - Length: ${info.length}`)
      console.log(`     - Masked: ${info.masked_value || 'N/A'}`)
      
      if (info.environment_variables) {
        console.log('     - Environment variables:')
        Object.entries(info.environment_variables).forEach(([envVar, exists]) => {
          console.log(`       - ${envVar}: ${exists ? '✓' : '✗'}`)
        })
      }
    })
    
    // Step 4: Test token verification with a sample token
    console.log('\n4. Token Verification Test:')
    
    // Create a sample JWT token for testing (this would be a real token in practice)
    const sampleToken = '<your-jwt-token>'
    
    const verification = await client.verifyJwtToken(projectRef, sampleToken)
    console.log('   - Token validation result:', verification.verification_result.is_valid)
    
    if (verification.verification_result.is_valid) {
      console.log('   - Secret source used:', verification.verification_result.secret_source)
      console.log('   - Token expires at:', verification.verification_result.token_info?.expires_at)
      console.log('   - Is expired:', verification.verification_result.token_info?.is_expired)
    } else {
      console.log('   - Verification failed - this is expected for the sample token')
      console.log('   - Attempted sources:', verification.verification_result.attempted_sources)
    }
    
    // Step 5: Summary and recommendations
    console.log('\n5. Summary and Recommendations:')
    
    const hasGlobal = projectSecret.available_sources.global.configured
    const hasProjectSpecific = projectSecret.available_sources.project_specific.configured
    const hasLegacy = projectSecret.available_sources.legacy.configured
    
    console.log('   - JWT Secret Configuration Status:')
    console.log(`     - Global: ${hasGlobal ? '✓' : '✗'}`)
    console.log(`     - Project-specific: ${hasProjectSpecific ? '✓' : '✗'}`)
    console.log(`     - Legacy: ${hasLegacy ? '✓' : '✗'}`)
    
    if (!hasGlobal && !hasProjectSpecific && !hasLegacy) {
      console.log('   ⚠️  WARNING: No JWT secrets configured!')
      console.log('   📝 Recommendation: Configure at least a global JWT secret')
    } else if (hasProjectSpecific) {
      console.log('   ✅ GOOD: Project-specific JWT secret is configured')
      console.log('   📝 This provides the best security isolation')
    } else if (hasGlobal) {
      console.log('   ✅ OK: Global JWT secret is configured')
      console.log('   📝 Consider adding project-specific secrets for better isolation')
    }
    
  } catch (error) {
    console.error('Error during complete JWT secret analysis:', error)
  }
}

/**
 * Example 5: Environment Variable Setup Helper
 */
export function exampleEnvironmentVariableSetup() {
  console.log('=== Environment Variable Setup Guide ===')
  
  console.log('\n1. Global JWT Secret (choose one):')
  console.log('   export SUPABASE_JWT_SECRET="your-global-jwt-secret-here"')
  console.log('   # OR')
  console.log('   export JWT_SECRET="your-global-jwt-secret-here"')
  
  console.log('\n2. Project-Specific JWT Secrets:')
  console.log('   # Replace PROJECT_REF with your actual project reference (uppercase)')
  console.log('   export JWT_SECRET_PROJECT1="project1-specific-secret"')
  console.log('   export JWT_SECRET_PROJECT2="project2-specific-secret"')
  console.log('   export SUPABASE_JWT_SECRET_MYPROJECT="myproject-specific-secret"')
  
  console.log('\n3. Security Configuration:')
  console.log('   # Enable JWT secret reveal endpoint (use with caution)')
  console.log('   export ALLOW_JWT_SECRET_REVEAL="true"')
  
  console.log('\n4. Verification:')
  console.log('   # Check if environment variables are set')
  console.log('   echo "Global JWT Secret: ${SUPABASE_JWT_SECRET:+SET}"')
  console.log('   echo "Project Specific: ${JWT_SECRET_MYPROJECT:+SET}"')
  console.log('   echo "Reveal Enabled: ${ALLOW_JWT_SECRET_REVEAL:+SET}"')
  
  console.log('\n5. Docker Compose Example:')
  console.log('   environment:')
  console.log('     - SUPABASE_JWT_SECRET=your-global-jwt-secret')
  console.log('     - JWT_SECRET_PROJECT1=project1-specific-secret')
  console.log('     - ALLOW_JWT_SECRET_REVEAL=true')
}

/**
 * Run all examples
 */
export async function runAllExamples() {
  console.log('🚀 Running JWT Secrets API Examples...\n')
  
  // Example 1: Basic information
  await exampleBasicJwtSecretInfo()
  
  console.log('\n' + '='.repeat(60) + '\n')
  
  // Example 2: Token verification
  await exampleJwtTokenVerification()
  
  console.log('\n' + '='.repeat(60) + '\n')
  
  // Example 3: Complete analysis
  await exampleCompleteJwtSecretAnalysis()
  
  console.log('\n' + '='.repeat(60) + '\n')
  
  // Example 4: Environment setup guide
  exampleEnvironmentVariableSetup()
  
  console.log('\n✅ All examples completed!')
  console.log('\n📝 Note: Replace "your-auth-token-here" and "my-project-ref" with actual values')
  console.log('⚠️  Warning: The JWT secret reveal example is commented out for security')
}

// Uncomment to run examples
// runAllExamples().catch(console.error)
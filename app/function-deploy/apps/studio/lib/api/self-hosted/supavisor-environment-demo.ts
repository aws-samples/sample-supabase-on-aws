#!/usr/bin/env node

/**
 * Supavisor Environment Configuration Demo
 * 
 * This script demonstrates the environment variable parsing and validation
 * functionality for Supavisor configuration.
 */

import {
  parseSupavisorEnvironmentVariables,
  getSupavisorConfigurationStatus,
  getEnvironmentVariableInfo,
  generateSetupGuidance,
  getConfigurationSummary,
  formatValidationErrors
} from './supavisor-environment-utils'

function runDemo() {
  console.log('🔧 Supavisor Environment Configuration Demo\n')

  // Parse current environment
  const { config, validation } = parseSupavisorEnvironmentVariables()
  
  console.log('📊 Current Configuration Status:')
  console.log('================================')
  const status = getSupavisorConfigurationStatus()
  console.log(`✅ Configured: ${status.isConfigured}`)
  console.log(`❌ Errors: ${status.errorCount}`)
  console.log(`⚠️  Warnings: ${status.warningCount}`)
  console.log(`📝 Summary: ${status.summary}\n`)

  if (!validation.isValid || validation.warnings.length > 0) {
    console.log('🚨 Validation Issues:')
    console.log('=====================')
    const messages = formatValidationErrors(validation)
    messages.forEach(message => console.log(message))
    console.log()
  }

  console.log('🔍 Environment Variables:')
  console.log('=========================')
  const variables = getEnvironmentVariableInfo()
  variables.forEach(variable => {
    const status = variable.isSet ? '✅' : (variable.isRequired ? '❌' : '⚪')
    const value = variable.isSet ? variable.value : `(default: ${variable.defaultValue || 'none'})`
    console.log(`${status} ${variable.name}: ${value}`)
    
    if (variable.hasError) {
      console.log(`   ❌ Error: ${variable.errorMessage}`)
    }
    if (variable.hasWarning) {
      console.log(`   ⚠️  Warning: ${variable.warningMessage}`)
    }
  })
  console.log()

  console.log('📋 Parsed Configuration:')
  console.log('========================')
  console.log(JSON.stringify(config, null, 2))
  console.log()

  if (status.hasErrors || status.hasWarnings) {
    console.log('💡 Setup Guidance:')
    console.log('==================')
    const guidance = generateSetupGuidance()
    
    if (guidance.requiredActions.length > 0) {
      console.log('Required Actions:')
      guidance.requiredActions.forEach(action => console.log(`  • ${action}`))
      console.log()
    }
    
    if (guidance.recommendations.length > 0) {
      console.log('Recommendations:')
      guidance.recommendations.forEach(rec => console.log(`  • ${rec}`))
      console.log()
    }
    
    console.log('Example Configuration:')
    console.log('---------------------')
    Object.entries(guidance.exampleConfiguration).forEach(([key, value]) => {
      console.log(`export ${key}="${value}"`)
    })
    console.log()
  }

  console.log('📄 Full Summary:')
  console.log('================')
  console.log(getConfigurationSummary())
}

// Run demo if this file is executed directly
if (require.main === module) {
  runDemo()
}

export { runDemo }
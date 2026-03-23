/**
 * Full-Text Search Demo
 * Demonstrates the full-text search functionality implementation
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5
 */

import { FullTextSearchService } from './full-text-search-service'

// Demo function to show full-text search parsing
export function demonstrateFullTextSearch() {
  const service = FullTextSearchService.getInstance()

  console.log('=== Full-Text Search Service Demo ===\n')

  // Demo 1: Parse FTS operators
  console.log('1. Parsing full-text search operators:')
  const query1 = {
    'content.fts': 'search term',
    'title.plfts': 'plain text search',
    'description.phfts': 'exact phrase',
    'body.wfts': '"quoted phrase" +required -excluded'
  }

  const filters1 = service.parseFullTextSearchOperators(query1)
  console.log('Query:', JSON.stringify(query1, null, 2))
  console.log('Parsed filters:', JSON.stringify(filters1, null, 2))
  console.log()

  // Demo 2: Parse with text search configuration
  console.log('2. Parsing with text search configuration:')
  const query2 = {
    'content.fts.spanish': 'búsqueda en español',
    'title.plfts.french': 'recherche en français'
  }

  const filters2 = service.parseFullTextSearchOperators(query2)
  console.log('Query:', JSON.stringify(query2, null, 2))
  console.log('Parsed filters:', JSON.stringify(filters2, null, 2))
  console.log()

  // Demo 3: Build WHERE clauses
  console.log('3. Building SQL WHERE clauses:')
  const whereClause1 = service.buildFullTextSearchWhereClause(filters1)
  console.log('WHERE clause:', whereClause1.clause)
  console.log('Parameters:', whereClause1.params)
  console.log()

  const whereClause2 = service.buildFullTextSearchWhereClause(filters2)
  console.log('WHERE clause with config:', whereClause2.clause)
  console.log('Parameters:', whereClause2.params)
  console.log()

  // Demo 4: Show supported operators
  console.log('4. Supported full-text search operators:')
  const operators = service.getSupportedOperators()
  operators.forEach(op => {
    console.log(`- ${op.operator}: ${op.description}`)
    console.log(`  Example: ${op.example}`)
    console.log(`  Performance: ${op.performanceNote}`)
    console.log()
  })

  console.log('=== Demo Complete ===')
}

// Run demo if this file is executed directly
if (require.main === module) {
  demonstrateFullTextSearch()
}
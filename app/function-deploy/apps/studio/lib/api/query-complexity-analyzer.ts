/**
 * Query Complexity Analyzer
 * 
 * Analyzes SQL queries to determine their complexity and potential performance impact.
 * Provides recommendations for optimization and determines if queries should be rejected.
 * 
 * Requirements: 13.3
 */

import { executeQuery } from './self-hosted/query'
import { WrappedResult } from './self-hosted/types'

/**
 * Query complexity analysis result
 */
export interface QueryComplexityResult {
  query: string
  complexityScore: number
  riskLevel: 'low' | 'medium' | 'high' | 'critical'
  factors: ComplexityFactor[]
  recommendations: string[]
  shouldReject: boolean
  estimatedExecutionTime: number
  estimatedMemoryUsage: number
  indexRecommendations: IndexRecommendation[]
}

/**
 * Complexity factor that contributes to overall query complexity
 */
export interface ComplexityFactor {
  type: ComplexityFactorType
  weight: number
  impact: number
  description: string
  suggestion?: string
}

/**
 * Types of complexity factors
 */
export type ComplexityFactorType = 
  | 'table_count'
  | 'join_count' 
  | 'subquery_count'
  | 'aggregate_count'
  | 'sort_operations'
  | 'filter_complexity'
  | 'result_set_size'
  | 'nested_operations'
  | 'function_calls'
  | 'window_functions'

/**
 * Index recommendation
 */
export interface IndexRecommendation {
  table: string
  columns: string[]
  type: 'btree' | 'hash' | 'gin' | 'gist'
  reason: string
  priority: 'high' | 'medium' | 'low'
  estimatedImprovement: string
}

/**
 * Query pattern that indicates complexity
 */
interface QueryPattern {
  pattern: RegExp
  type: ComplexityFactorType
  weight: number
  description: string
  suggestion?: string
}

/**
 * Predefined query patterns for complexity analysis
 */
const COMPLEXITY_PATTERNS: QueryPattern[] = [
  {
    pattern: /\bjoin\b/gi,
    type: 'join_count',
    weight: 2,
    description: 'JOIN operations increase query complexity',
    suggestion: 'Ensure proper indexing on join columns'
  },
  {
    pattern: /\b(left|right|full|inner|outer)\s+join\b/gi,
    type: 'join_count',
    weight: 2.5,
    description: 'Complex JOIN types require more processing',
    suggestion: 'Consider if all JOINs are necessary'
  },
  {
    pattern: /\(\s*select\b/gi,
    type: 'subquery_count',
    weight: 3,
    description: 'Subqueries can significantly impact performance',
    suggestion: 'Consider rewriting subqueries as JOINs where possible'
  },
  {
    pattern: /\bwith\s+\w+\s+as\s*\(/gi,
    type: 'subquery_count',
    weight: 2,
    description: 'Common Table Expressions (CTEs) add complexity',
    suggestion: 'CTEs are generally well-optimized but monitor performance'
  },
  {
    pattern: /\b(count|sum|avg|min|max|array_agg|string_agg)\s*\(/gi,
    type: 'aggregate_count',
    weight: 1.5,
    description: 'Aggregate functions require additional processing',
    suggestion: 'Ensure GROUP BY columns are indexed'
  },
  {
    pattern: /\bgroup\s+by\b/gi,
    type: 'aggregate_count',
    weight: 2,
    description: 'GROUP BY operations require sorting and grouping',
    suggestion: 'Index columns used in GROUP BY clause'
  },
  {
    pattern: /\bhaving\b/gi,
    type: 'filter_complexity',
    weight: 2,
    description: 'HAVING clauses filter after aggregation',
    suggestion: 'Move conditions to WHERE clause when possible'
  },
  {
    pattern: /\border\s+by\b/gi,
    type: 'sort_operations',
    weight: 1.5,
    description: 'ORDER BY requires sorting operations',
    suggestion: 'Index columns used for sorting'
  },
  {
    pattern: /\bover\s*\(/gi,
    type: 'window_functions',
    weight: 3,
    description: 'Window functions are computationally expensive',
    suggestion: 'Limit window function usage and ensure proper partitioning'
  },
  {
    pattern: /\bunion\b/gi,
    type: 'nested_operations',
    weight: 2,
    description: 'UNION operations combine multiple result sets',
    suggestion: 'Consider if UNION ALL can be used instead of UNION'
  },
  {
    pattern: /\bexists\s*\(/gi,
    type: 'subquery_count',
    weight: 2,
    description: 'EXISTS clauses use correlated subqueries',
    suggestion: 'EXISTS is often well-optimized but monitor performance'
  },
  {
    pattern: /\bin\s*\(\s*select\b/gi,
    type: 'subquery_count',
    weight: 3,
    description: 'IN with subquery can be expensive',
    suggestion: 'Consider using EXISTS or JOIN instead'
  }
]

/**
 * Query Complexity Analyzer
 */
export class QueryComplexityAnalyzer {
  private static instance: QueryComplexityAnalyzer
  private maxComplexityScore: number = 75
  private criticalComplexityScore: number = 90

  private constructor() {}

  static getInstance(): QueryComplexityAnalyzer {
    if (!QueryComplexityAnalyzer.instance) {
      QueryComplexityAnalyzer.instance = new QueryComplexityAnalyzer()
    }
    return QueryComplexityAnalyzer.instance
  }

  /**
   * Analyze query complexity
   * Requirements: 13.3
   */
  async analyzeQuery(
    query: string,
    projectRef?: string
  ): Promise<QueryComplexityResult> {
    const normalizedQuery = this.normalizeQuery(query)
    const factors = this.analyzeComplexityFactors(normalizedQuery)
    const complexityScore = this.calculateComplexityScore(factors)
    const riskLevel = this.determineRiskLevel(complexityScore)
    const recommendations = this.generateRecommendations(factors, normalizedQuery)
    const indexRecommendations = this.generateIndexRecommendations(normalizedQuery)
    
    // Estimate execution time and memory usage
    const estimatedExecutionTime = this.estimateExecutionTime(complexityScore, factors)
    const estimatedMemoryUsage = this.estimateMemoryUsage(complexityScore, factors)

    return {
      query: normalizedQuery,
      complexityScore,
      riskLevel,
      factors,
      recommendations,
      shouldReject: complexityScore > this.maxComplexityScore,
      estimatedExecutionTime,
      estimatedMemoryUsage,
      indexRecommendations
    }
  }

  /**
   * Analyze complexity factors in the query
   */
  private analyzeComplexityFactors(query: string): ComplexityFactor[] {
    const factors: ComplexityFactor[] = []

    // Analyze each pattern
    for (const pattern of COMPLEXITY_PATTERNS) {
      const matches = query.match(pattern.pattern)
      if (matches) {
        const count = matches.length
        const impact = count * pattern.weight
        
        factors.push({
          type: pattern.type,
          weight: pattern.weight,
          impact,
          description: `${pattern.description} (found ${count} instances)`,
          suggestion: pattern.suggestion
        })
      }
    }

    // Analyze table count
    const tableMatches = query.match(/\bfrom\s+(\w+)|join\s+(\w+)/gi)
    if (tableMatches) {
      const uniqueTables = new Set(
        tableMatches.map(match => 
          match.replace(/^(from|join)\s+/i, '').trim().toLowerCase()
        )
      )
      const tableCount = uniqueTables.size
      
      if (tableCount > 1) {
        factors.push({
          type: 'table_count',
          weight: 1,
          impact: tableCount * 1,
          description: `Query involves ${tableCount} tables`,
          suggestion: tableCount > 5 ? 'Consider breaking into smaller queries' : undefined
        })
      }
    }

    // Analyze WHERE clause complexity
    const whereMatch = query.match(/\bwhere\b(.+?)(?:\bgroup\s+by\b|\border\s+by\b|\blimit\b|$)/i)
    if (whereMatch) {
      const whereClause = whereMatch[1]
      const conditionCount = (whereClause.match(/\b(and|or)\b/gi) || []).length + 1
      const hasComplexConditions = /\b(like|ilike|~|similar\s+to)\b/i.test(whereClause)
      
      if (conditionCount > 3 || hasComplexConditions) {
        const impact = conditionCount + (hasComplexConditions ? 2 : 0)
        factors.push({
          type: 'filter_complexity',
          weight: 1.5,
          impact,
          description: `Complex WHERE clause with ${conditionCount} conditions`,
          suggestion: 'Ensure filtered columns are indexed'
        })
      }
    }

    // Check for missing LIMIT
    if (query.includes('select') && !query.includes('limit')) {
      factors.push({
        type: 'result_set_size',
        weight: 2,
        impact: 5,
        description: 'Query lacks LIMIT clause, may return large result sets',
        suggestion: 'Add LIMIT clause to restrict result set size'
      })
    }

    return factors
  }

  /**
   * Calculate overall complexity score
   */
  private calculateComplexityScore(factors: ComplexityFactor[]): number {
    let totalScore = 0
    let maxImpact = 0

    for (const factor of factors) {
      totalScore += factor.impact
      maxImpact = Math.max(maxImpact, factor.impact)
    }

    // Apply diminishing returns for very high scores
    if (totalScore > 50) {
      totalScore = 50 + Math.log(totalScore - 50) * 10
    }

    // Cap the maximum score
    return Math.min(totalScore, 100)
  }

  /**
   * Determine risk level based on complexity score
   */
  private determineRiskLevel(score: number): 'low' | 'medium' | 'high' | 'critical' {
    if (score >= this.criticalComplexityScore) return 'critical'
    if (score >= this.maxComplexityScore) return 'high'
    if (score >= 40) return 'medium'
    return 'low'
  }

  /**
   * Generate optimization recommendations
   */
  private generateRecommendations(factors: ComplexityFactor[], query: string): string[] {
    const recommendations: string[] = []
    const factorTypes = new Set(factors.map(f => f.type))

    // General recommendations based on factors
    if (factorTypes.has('join_count')) {
      recommendations.push('Ensure all JOIN columns are properly indexed')
      recommendations.push('Consider if all JOINs are necessary for the result')
    }

    if (factorTypes.has('subquery_count')) {
      recommendations.push('Consider rewriting subqueries as JOINs where possible')
      recommendations.push('Ensure subquery conditions are selective')
    }

    if (factorTypes.has('aggregate_count')) {
      recommendations.push('Index columns used in GROUP BY clauses')
      recommendations.push('Consider pre-aggregating data for frequently used aggregations')
    }

    if (factorTypes.has('sort_operations')) {
      recommendations.push('Create indexes on columns used in ORDER BY')
      recommendations.push('Consider if sorting is necessary for the application')
    }

    if (factorTypes.has('result_set_size')) {
      recommendations.push('Add LIMIT clause to restrict result set size')
      recommendations.push('Use pagination for large result sets')
    }

    if (factorTypes.has('window_functions')) {
      recommendations.push('Ensure window function partitions are well-defined')
      recommendations.push('Consider if window functions can be replaced with simpler operations')
    }

    // Add factor-specific suggestions
    for (const factor of factors) {
      if (factor.suggestion && !recommendations.includes(factor.suggestion)) {
        recommendations.push(factor.suggestion)
      }
    }

    return recommendations
  }

  /**
   * Generate index recommendations based on query analysis
   */
  private generateIndexRecommendations(query: string): IndexRecommendation[] {
    const recommendations: IndexRecommendation[] = []

    // Analyze WHERE clause for index opportunities
    const whereMatch = query.match(/\bwhere\b(.+?)(?:\bgroup\s+by\b|\border\s+by\b|\blimit\b|$)/i)
    if (whereMatch) {
      const whereClause = whereMatch[1]
      
      // Look for equality conditions
      const equalityMatches = whereClause.match(/(\w+)\s*=\s*/g)
      if (equalityMatches) {
        equalityMatches.forEach(match => {
          const column = match.replace(/\s*=\s*$/, '').trim()
          recommendations.push({
            table: 'table_name', // Would need table analysis to determine actual table
            columns: [column],
            type: 'btree',
            reason: `Equality condition on ${column}`,
            priority: 'high',
            estimatedImprovement: 'Significant improvement for equality lookups'
          })
        })
      }

      // Look for range conditions
      const rangeMatches = whereClause.match(/(\w+)\s*[<>]=?\s*/g)
      if (rangeMatches) {
        rangeMatches.forEach(match => {
          const column = match.replace(/\s*[<>]=?\s*$/, '').trim()
          recommendations.push({
            table: 'table_name',
            columns: [column],
            type: 'btree',
            reason: `Range condition on ${column}`,
            priority: 'medium',
            estimatedImprovement: 'Good improvement for range queries'
          })
        })
      }
    }

    // Analyze JOIN conditions
    const joinMatches = query.match(/join\s+(\w+)\s+.*?on\s+(.+?)(?:\s+(?:join|where|group|order|limit)|$)/gi)
    if (joinMatches) {
      joinMatches.forEach(match => {
        const onClause = match.match(/on\s+(.+)$/i)?.[1]
        if (onClause) {
          const columns = onClause.match(/(\w+)\s*=\s*(\w+)/g)
          if (columns) {
            columns.forEach(condition => {
              const [left, right] = condition.split('=').map(s => s.trim())
              recommendations.push({
                table: 'table_name',
                columns: [left, right],
                type: 'btree',
                reason: `JOIN condition between ${left} and ${right}`,
                priority: 'high',
                estimatedImprovement: 'Critical for JOIN performance'
              })
            })
          }
        }
      })
    }

    // Analyze ORDER BY clause
    const orderByMatch = query.match(/\border\s+by\s+(.+?)(?:\blimit\b|$)/i)
    if (orderByMatch) {
      const orderByClause = orderByMatch[1].trim()
      const columns = orderByClause.split(',').map(col => col.trim().split(' ')[0])
      
      recommendations.push({
        table: 'table_name',
        columns,
        type: 'btree',
        reason: `ORDER BY on ${columns.join(', ')}`,
        priority: 'medium',
        estimatedImprovement: 'Eliminates sorting overhead'
      })
    }

    return recommendations
  }

  /**
   * Estimate query execution time based on complexity
   */
  private estimateExecutionTime(score: number, factors: ComplexityFactor[]): number {
    let baseTime = 10 // Base 10ms
    
    // Scale exponentially with complexity score
    const complexityMultiplier = Math.pow(1.1, score)
    
    // Add specific penalties for expensive operations
    for (const factor of factors) {
      switch (factor.type) {
        case 'subquery_count':
          baseTime += factor.impact * 50
          break
        case 'join_count':
          baseTime += factor.impact * 20
          break
        case 'window_functions':
          baseTime += factor.impact * 100
          break
        case 'aggregate_count':
          baseTime += factor.impact * 30
          break
        default:
          baseTime += factor.impact * 10
      }
    }

    return Math.min(baseTime * complexityMultiplier, 30000) // Cap at 30 seconds
  }

  /**
   * Estimate memory usage based on complexity
   */
  private estimateMemoryUsage(score: number, factors: ComplexityFactor[]): number {
    let baseMemory = 1024 * 1024 // Base 1MB
    
    // Scale with complexity
    const memoryMultiplier = Math.pow(1.05, score)
    
    // Add specific memory requirements
    for (const factor of factors) {
      switch (factor.type) {
        case 'result_set_size':
          baseMemory += factor.impact * 1024 * 1024 // 1MB per impact point
          break
        case 'aggregate_count':
          baseMemory += factor.impact * 512 * 1024 // 512KB per aggregation
          break
        case 'sort_operations':
          baseMemory += factor.impact * 2 * 1024 * 1024 // 2MB for sorting
          break
        case 'window_functions':
          baseMemory += factor.impact * 4 * 1024 * 1024 // 4MB for window functions
          break
      }
    }

    return Math.min(baseMemory * memoryMultiplier, 512 * 1024 * 1024) // Cap at 512MB
  }

  /**
   * Normalize query for analysis
   */
  private normalizeQuery(query: string): string {
    return query
      .replace(/\s+/g, ' ') // Normalize whitespace
      .replace(/--.*$/gm, '') // Remove comments
      .replace(/\/\*[\s\S]*?\*\//g, '') // Remove block comments
      .trim()
  }

  /**
   * Update complexity thresholds
   */
  updateThresholds(maxScore: number, criticalScore: number): void {
    this.maxComplexityScore = maxScore
    this.criticalComplexityScore = criticalScore
  }

  /**
   * Get current thresholds
   */
  getThresholds(): { max: number; critical: number } {
    return {
      max: this.maxComplexityScore,
      critical: this.criticalComplexityScore
    }
  }
}

/**
 * Factory function to get the query complexity analyzer
 */
export function getQueryComplexityAnalyzer(): QueryComplexityAnalyzer {
  return QueryComplexityAnalyzer.getInstance()
}
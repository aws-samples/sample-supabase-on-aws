/**
 * Database adapter for Credential Monitoring Service.
 * Provides persistent storage for audit logs and credential monitoring data.
 */

import { createClient } from '@supabase/supabase-js'
import type { CredentialAuditLog } from './credential-monitoring-service'

/**
 * Database configuration for credential monitoring
 */
interface DatabaseConfig {
  supabaseUrl: string
  supabaseKey: string
}

/**
 * Database adapter for credential monitoring operations
 */
export class CredentialMonitoringDatabase {
  private supabase: ReturnType<typeof createClient>

  constructor(config: DatabaseConfig) {
    this.supabase = createClient(config.supabaseUrl, config.supabaseKey)
  }

  /**
   * Inserts an audit log entry into the database
   * 
   * @param entry - Audit log entry to insert
   * @returns Promise resolving to the inserted entry with database ID
   */
  async insertAuditLogEntry(entry: Omit<CredentialAuditLog, 'id'>): Promise<CredentialAuditLog> {
    const { data, error } = await this.supabase
      .from('credential_audit_log')
      .insert({
        project_ref: entry.project_ref,
        event_type: entry.event_type,
        event_details: entry.event_details,
        timestamp: entry.timestamp,
        user_id: entry.user_id
      })
      .select()
      .single()

    if (error) {
      throw new Error(`Failed to insert audit log entry: ${error.message}`)
    }

    return {
      id: data.id,
      project_ref: data.project_ref,
      event_type: data.event_type,
      event_details: data.event_details,
      timestamp: data.timestamp,
      user_id: data.user_id
    }
  }

  /**
   * Retrieves audit log entries from the database
   * 
   * @param options - Query options for filtering and pagination
   * @returns Promise resolving to array of audit log entries
   */
  async getAuditLogEntries(options: {
    limit?: number
    offset?: number
    eventType?: string
    projectRef?: string
    startDate?: string
    endDate?: string
  } = {}): Promise<CredentialAuditLog[]> {
    let query = this.supabase
      .from('credential_audit_log')
      .select('*')
      .order('timestamp', { ascending: false })

    if (options.eventType) {
      query = query.eq('event_type', options.eventType)
    }

    if (options.projectRef) {
      query = query.eq('project_ref', options.projectRef)
    }

    if (options.startDate) {
      query = query.gte('timestamp', options.startDate)
    }

    if (options.endDate) {
      query = query.lte('timestamp', options.endDate)
    }

    if (options.limit) {
      query = query.limit(options.limit)
    }

    if (options.offset) {
      query = query.range(options.offset, options.offset + (options.limit || 100) - 1)
    }

    const { data, error } = await query

    if (error) {
      throw new Error(`Failed to retrieve audit log entries: ${error.message}`)
    }

    return data || []
  }

  /**
   * Gets audit log statistics from the database
   * 
   * @param options - Options for filtering statistics
   * @returns Promise resolving to audit log statistics
   */
  async getAuditLogStatistics(options: {
    startDate?: string
    endDate?: string
  } = {}): Promise<{
    totalEntries: number
    eventTypeCounts: { event_type: string; count: number }[]
    projectCounts: { project_ref: string; count: number }[]
  }> {
    let baseQuery = this.supabase.from('credential_audit_log')

    if (options.startDate) {
      baseQuery = baseQuery.gte('timestamp', options.startDate)
    }

    if (options.endDate) {
      baseQuery = baseQuery.lte('timestamp', options.endDate)
    }

    // Get total count
    const { count: totalEntries, error: countError } = await baseQuery
      .select('*', { count: 'exact', head: true })

    if (countError) {
      throw new Error(`Failed to get total audit log count: ${countError.message}`)
    }

    // Get event type counts using a raw SQL query for better performance
    const eventTypeQuery = `
      SELECT event_type, COUNT(*) as count
      FROM credential_audit_log
      ${options.startDate ? `WHERE timestamp >= '${options.startDate}'` : ''}
      ${options.endDate ? `${options.startDate ? 'AND' : 'WHERE'} timestamp <= '${options.endDate}'` : ''}
      GROUP BY event_type
      ORDER BY count DESC
    `

    const { data: eventTypeCounts, error: eventTypeError } = await this.supabase
      .rpc('execute_sql', { query: eventTypeQuery })

    if (eventTypeError) {
      // Fallback to a simpler approach if RPC is not available
      const { data: allEntries, error: entriesError } = await baseQuery.select('event_type')
      
      if (entriesError) {
        throw new Error(`Failed to get event type counts: ${entriesError.message}`)
      }

      const eventTypeMap = new Map<string, number>()
      allEntries?.forEach(entry => {
        const count = eventTypeMap.get(entry.event_type) || 0
        eventTypeMap.set(entry.event_type, count + 1)
      })

      const eventTypeCounts = Array.from(eventTypeMap.entries())
        .map(([event_type, count]) => ({ event_type, count }))
        .sort((a, b) => b.count - a.count)

      return {
        totalEntries: totalEntries || 0,
        eventTypeCounts,
        projectCounts: []
      }
    }

    // Get project counts
    const projectQuery = `
      SELECT project_ref, COUNT(*) as count
      FROM credential_audit_log
      ${options.startDate ? `WHERE timestamp >= '${options.startDate}'` : ''}
      ${options.endDate ? `${options.startDate ? 'AND' : 'WHERE'} timestamp <= '${options.endDate}'` : ''}
      GROUP BY project_ref
      ORDER BY count DESC
      LIMIT 20
    `

    const { data: projectCounts, error: projectError } = await this.supabase
      .rpc('execute_sql', { query: projectQuery })

    return {
      totalEntries: totalEntries || 0,
      eventTypeCounts: eventTypeCounts || [],
      projectCounts: projectCounts || []
    }
  }

  /**
   * Cleans up old audit log entries
   * 
   * @param olderThanDays - Remove entries older than this many days (default: 180)
   * @returns Promise resolving to the number of deleted entries
   */
  async cleanupOldAuditLogs(olderThanDays: number = 180): Promise<number> {
    const cutoffDate = new Date()
    cutoffDate.setDate(cutoffDate.getDate() - olderThanDays)

    const { data, error } = await this.supabase
      .from('credential_audit_log')
      .delete()
      .lt('created_at', cutoffDate.toISOString())
      .select('id')

    if (error) {
      throw new Error(`Failed to cleanup old audit logs: ${error.message}`)
    }

    return data?.length || 0
  }

  /**
   * Gets recent fallback usage for specific projects
   * 
   * @param projectRefs - Array of project references to check
   * @param limit - Maximum number of entries per project
   * @returns Promise resolving to fallback usage entries grouped by project
   */
  async getRecentFallbackUsageByProjects(
    projectRefs: string[],
    limit: number = 10
  ): Promise<Record<string, CredentialAuditLog[]>> {
    if (projectRefs.length === 0) {
      return {}
    }

    const { data, error } = await this.supabase
      .from('credential_audit_log')
      .select('*')
      .in('project_ref', projectRefs)
      .eq('event_type', 'fallback_used')
      .order('timestamp', { ascending: false })
      .limit(limit * projectRefs.length)

    if (error) {
      throw new Error(`Failed to get recent fallback usage: ${error.message}`)
    }

    // Group by project_ref
    const grouped: Record<string, CredentialAuditLog[]> = {}
    
    projectRefs.forEach(ref => {
      grouped[ref] = []
    })

    data?.forEach(entry => {
      if (grouped[entry.project_ref] && grouped[entry.project_ref].length < limit) {
        grouped[entry.project_ref].push(entry)
      }
    })

    return grouped
  }

  /**
   * Records a batch of audit log entries
   * 
   * @param entries - Array of audit log entries to insert
   * @returns Promise resolving to the inserted entries with database IDs
   */
  async insertAuditLogBatch(entries: Omit<CredentialAuditLog, 'id'>[]): Promise<CredentialAuditLog[]> {
    if (entries.length === 0) {
      return []
    }

    const { data, error } = await this.supabase
      .from('credential_audit_log')
      .insert(entries.map(entry => ({
        project_ref: entry.project_ref,
        event_type: entry.event_type,
        event_details: entry.event_details,
        timestamp: entry.timestamp,
        user_id: entry.user_id
      })))
      .select()

    if (error) {
      throw new Error(`Failed to insert audit log batch: ${error.message}`)
    }

    return data || []
  }
}

/**
 * Creates a database adapter instance with environment configuration
 * 
 * @returns CredentialMonitoringDatabase instance
 */
export function createCredentialMonitoringDatabase(): CredentialMonitoringDatabase {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Missing Supabase configuration for credential monitoring database')
  }

  return new CredentialMonitoringDatabase({
    supabaseUrl,
    supabaseKey
  })
}
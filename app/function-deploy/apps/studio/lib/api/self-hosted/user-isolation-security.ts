/**
 * User isolation verification and security utilities.
 * Provides functions to verify project-specific database user isolation,
 * prevent cross-project access, and audit user permissions.
 */

import { executeQuery } from './query'
import { WrappedResult } from './types'
import { getUserPermissions, validateUsername, DatabaseUserError, DatabaseUserErrorCode } from './database-user-manager'

/**
 * Result of cross-project access verification
 */
export interface CrossProjectAccessResult {
  /** Whether the user can access the target database */
  canAccess: boolean
  /** Specific permissions the user has on the target database */
  permissions: string[]
  /** Error message if access check failed */
  error?: string
}

/**
 * User access audit log entry
 */
export interface UserAccessAuditLog {
  /** Username being audited */
  username: string
  /** Database being accessed */
  database: string
  /** Timestamp of the audit */
  timestamp: Date
  /** Type of access being audited */
  accessType: 'CONNECT' | 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'CREATE' | 'DROP'
  /** Whether access was granted or denied */
  granted: boolean
  /** Additional details about the access attempt */
  details?: string
}

/**
 * Isolation verification report
 */
export interface IsolationVerificationReport {
  /** Overall isolation status */
  isolationStatus: 'SECURE' | 'COMPROMISED' | 'UNKNOWN'
  /** List of users checked */
  usersChecked: string[]
  /** List of databases checked */
  databasesChecked: string[]
  /** Any security violations found */
  violations: SecurityViolation[]
  /** Summary of findings */
  summary: string
  /** Timestamp of the verification */
  timestamp: Date
}

/**
 * Security violation details
 */
export interface SecurityViolation {
  /** Type of violation */
  type: 'CROSS_PROJECT_ACCESS' | 'EXCESSIVE_PRIVILEGES' | 'MISSING_ISOLATION'
  /** Severity level */
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
  /** Username involved in the violation */
  username: string
  /** Database involved in the violation */
  database: string
  /** Description of the violation */
  description: string
  /** Recommended action to fix the violation */
  recommendation: string
}

/**
 * Verifies that a user cannot access databases from other projects
 * 
 * @param username - Username to check
 * @param targetDatabase - Database the user should NOT be able to access
 * @returns Result with access verification details
 */
export async function verifyCrossProjectAccessDenial(
  username: string,
  targetDatabase: string
): Promise<WrappedResult<CrossProjectAccessResult>> {
  try {
    validateUsername(username)
  } catch (error) {
    if (error instanceof DatabaseUserError) {
      return { data: undefined, error }
    }
    return {
      data: undefined,
      error: new DatabaseUserError(
        DatabaseUserErrorCode.UNKNOWN_ERROR,
        error instanceof Error ? error.message : 'Validation failed'
      )
    }
  }

  // Check if user exists
  const { userExists } = await import('./database-user-manager')
  const existsResult = await userExists(username)
  if (existsResult.error) {
    return { data: undefined, error: existsResult.error }
  }
  if (!existsResult.data) {
    return {
      data: undefined,
      error: new DatabaseUserError(
        DatabaseUserErrorCode.INVALID_USERNAME,
        `User "${username}" does not exist`,
        { username }
      )
    }
  }

  // Check database-level permissions
  const permissions: string[] = []
  const permissionChecks = [
    { privilege: 'CONNECT', description: 'connect to database' },
    { privilege: 'CREATE', description: 'create objects in database' },
    { privilege: 'TEMPORARY', description: 'create temporary objects' }
  ]

  for (const check of permissionChecks) {
    const query = `SELECT has_database_privilege($1, $2, $3) as has_privilege`
    
    const result = await executeQuery<{ has_privilege: boolean }>({
      query,
      parameters: [username, targetDatabase, check.privilege],
      readOnly: true,
    })

    if (result.error) {
      return {
        data: {
          canAccess: false,
          permissions: [],
          error: `Failed to check ${check.privilege} permission: ${result.error.message}`
        },
        error: undefined
      }
    }

    const hasPrivilege = result.data?.[0]?.has_privilege ?? false
    if (hasPrivilege) {
      permissions.push(check.privilege)
    }
  }

  const canAccess = permissions.length > 0

  return {
    data: {
      canAccess,
      permissions,
      error: canAccess ? `User has unauthorized access to database "${targetDatabase}"` : undefined
    },
    error: undefined
  }
}

/**
 * Verifies that a user has the correct permissions on their assigned database
 * and no permissions on other databases
 * 
 * @param username - Username to verify
 * @param assignedDatabase - Database the user should have access to
 * @returns Result with permission verification details
 */
export async function verifyUserPermissions(
  username: string,
  assignedDatabase: string
): Promise<WrappedResult<{ hasCorrectPermissions: boolean; violations: SecurityViolation[] }>> {
  try {
    validateUsername(username)
  } catch (error) {
    if (error instanceof DatabaseUserError) {
      return { data: undefined, error }
    }
    return {
      data: undefined,
      error: new DatabaseUserError(
        DatabaseUserErrorCode.UNKNOWN_ERROR,
        error instanceof Error ? error.message : 'Validation failed'
      )
    }
  }

  const violations: SecurityViolation[] = []

  // Get user permissions
  const permissionsResult = await getUserPermissions(username)
  if (permissionsResult.error) {
    return { data: undefined, error: permissionsResult.error }
  }

  const userPermissions = permissionsResult.data!

  // Check if user has access to assigned database
  const hasAssignedAccess = userPermissions.databases.includes(assignedDatabase)
  if (!hasAssignedAccess) {
    violations.push({
      type: 'MISSING_ISOLATION',
      severity: 'CRITICAL',
      username,
      database: assignedDatabase,
      description: `User "${username}" does not have access to their assigned database "${assignedDatabase}"`,
      recommendation: `Grant appropriate permissions to user "${username}" on database "${assignedDatabase}"`
    })
  }

  // Check for unauthorized database access
  for (const database of userPermissions.databases) {
    if (database !== assignedDatabase && !database.startsWith('template') && database !== 'postgres') {
      violations.push({
        type: 'CROSS_PROJECT_ACCESS',
        severity: 'HIGH',
        username,
        database,
        description: `User "${username}" has unauthorized access to database "${database}"`,
        recommendation: `Revoke all permissions for user "${username}" on database "${database}"`
      })
    }
  }

  // Check for excessive system privileges
  if (userPermissions.isSuperuser) {
    violations.push({
      type: 'EXCESSIVE_PRIVILEGES',
      severity: 'CRITICAL',
      username,
      database: 'system',
      description: `User "${username}" has superuser privileges`,
      recommendation: `Remove superuser privileges from user "${username}"`
    })
  }

  if (userPermissions.canCreateDb) {
    violations.push({
      type: 'EXCESSIVE_PRIVILEGES',
      severity: 'MEDIUM',
      username,
      database: 'system',
      description: `User "${username}" can create databases`,
      recommendation: `Remove CREATEDB privilege from user "${username}"`
    })
  }

  if (userPermissions.canCreateRole) {
    violations.push({
      type: 'EXCESSIVE_PRIVILEGES',
      severity: 'HIGH',
      username,
      database: 'system',
      description: `User "${username}" can create roles`,
      recommendation: `Remove CREATEROLE privilege from user "${username}"`
    })
  }

  const hasCorrectPermissions = violations.length === 0

  return {
    data: {
      hasCorrectPermissions,
      violations
    },
    error: undefined
  }
}

/**
 * Logs user access attempts for audit purposes
 * 
 * @param auditLog - Audit log entry to record
 * @returns Result indicating success or error
 */
export async function logUserAccess(auditLog: UserAccessAuditLog): Promise<WrappedResult<void>> {
  // For now, we'll log to console. In a production environment,
  // this should be logged to a persistent audit log system
  const logEntry = {
    timestamp: auditLog.timestamp.toISOString(),
    username: auditLog.username,
    database: auditLog.database,
    accessType: auditLog.accessType,
    granted: auditLog.granted,
    details: auditLog.details || 'No additional details'
  }

  console.log('[USER_ACCESS_AUDIT]', JSON.stringify(logEntry))

  // In a real implementation, you might want to store this in a database table
  // or send it to an external logging service
  
  return { data: undefined, error: undefined }
}

/**
 * Runs a comprehensive isolation verification check across all project users
 * 
 * @returns Result with detailed isolation verification report
 */
export async function runIsolationVerification(): Promise<WrappedResult<IsolationVerificationReport>> {
  const report: IsolationVerificationReport = {
    isolationStatus: 'UNKNOWN',
    usersChecked: [],
    databasesChecked: [],
    violations: [],
    summary: '',
    timestamp: new Date()
  }

  try {
    // Get all project users (users that start with 'proj_')
    const usersQuery = `
      SELECT usename 
      FROM pg_user 
      WHERE usename LIKE 'proj_%'
      ORDER BY usename
    `

    const usersResult = await executeQuery<{ usename: string }>({
      query: usersQuery,
      readOnly: true,
    })

    if (usersResult.error) {
      return { data: undefined, error: usersResult.error }
    }

    const projectUsers = usersResult.data?.map(row => row.usename) || []
    report.usersChecked = projectUsers

    // Get all project databases (exclude system databases)
    const databasesQuery = `
      SELECT datname 
      FROM pg_database 
      WHERE datistemplate = false 
        AND datname NOT IN ('postgres', 'template0', 'template1')
      ORDER BY datname
    `

    const databasesResult = await executeQuery<{ datname: string }>({
      query: databasesQuery,
      readOnly: true,
    })

    if (databasesResult.error) {
      return { data: undefined, error: databasesResult.error }
    }

    const projectDatabases = databasesResult.data?.map(row => row.datname) || []
    report.databasesChecked = projectDatabases

    // For each user, verify their permissions
    for (const username of projectUsers) {
      // Determine the expected database for this user
      // Assuming the pattern: proj_<project_name> user should access <project_name> database
      const expectedDatabase = username.replace('proj_', '')
      
      if (projectDatabases.includes(expectedDatabase)) {
        const permissionResult = await verifyUserPermissions(username, expectedDatabase)
        if (permissionResult.error) {
          console.warn(`Failed to verify permissions for user ${username}:`, permissionResult.error.message)
          continue
        }

        if (permissionResult.data?.violations) {
          report.violations.push(...permissionResult.data.violations)
        }
      }

      // Check cross-project access for all other databases
      for (const database of projectDatabases) {
        if (database !== expectedDatabase) {
          try {
            const accessResult = await verifyCrossProjectAccessDenial(username, database)
            if (accessResult.error) {
              console.warn(`Failed to verify cross-project access for user ${username} on database ${database}:`, accessResult.error.message)
              continue
            }

            if (accessResult.data?.canAccess) {
              report.violations.push({
                type: 'CROSS_PROJECT_ACCESS',
                severity: 'HIGH',
                username,
                database,
                description: `User "${username}" has unauthorized access to database "${database}"`,
                recommendation: `Revoke all permissions for user "${username}" on database "${database}"`
              })
            }
          } catch (error) {
            console.warn(`Error during cross-project access check for user ${username} on database ${database}:`, error)
            continue
          }
        }
      }
    }

    // Determine overall isolation status
    const criticalViolations = report.violations.filter(v => v.severity === 'CRITICAL').length
    const highViolations = report.violations.filter(v => v.severity === 'HIGH').length
    const totalViolations = report.violations.length

    if (criticalViolations > 0) {
      report.isolationStatus = 'COMPROMISED'
    } else if (highViolations > 0) {
      report.isolationStatus = 'COMPROMISED'
    } else if (totalViolations === 0) {
      report.isolationStatus = 'SECURE'
    } else {
      report.isolationStatus = 'COMPROMISED'
    }

    // Generate summary
    if (totalViolations === 0) {
      report.summary = `Isolation verification passed. All ${projectUsers.length} project users have proper isolation.`
    } else {
      report.summary = `Isolation verification found ${totalViolations} violation(s): ${criticalViolations} critical, ${highViolations} high severity. Immediate action required.`
    }

    // Log the audit
    await logUserAccess({
      username: 'system',
      database: 'all',
      timestamp: new Date(),
      accessType: 'SELECT',
      granted: true,
      details: `Isolation verification completed. Status: ${report.isolationStatus}, Violations: ${totalViolations}`
    })

    return { data: report, error: undefined }

  } catch (error) {
    return {
      data: undefined,
      error: new DatabaseUserError(
        DatabaseUserErrorCode.UNKNOWN_ERROR,
        error instanceof Error ? error.message : 'Isolation verification failed'
      )
    }
  }
}

/**
 * Creates a verification script that can be run to validate user isolation
 * 
 * @returns SQL script content for manual verification
 */
export function generateIsolationVerificationScript(): string {
  return `
-- User Isolation Verification Script
-- This script verifies that project-specific database users have proper isolation

-- 1. List all project users and their basic attributes
SELECT 
  'PROJECT USERS' as section,
  usename as username,
  usesuper as is_superuser,
  usecreatedb as can_create_db,
  usecreaterole as can_create_role
FROM pg_user 
WHERE usename LIKE 'proj_%'
ORDER BY usename;

-- 2. Check database access permissions for each project user
SELECT 
  'DATABASE PERMISSIONS' as section,
  u.usename as username,
  d.datname as database,
  has_database_privilege(u.usename, d.datname, 'CONNECT') as can_connect,
  has_database_privilege(u.usename, d.datname, 'CREATE') as can_create,
  has_database_privilege(u.usename, d.datname, 'TEMPORARY') as can_temp
FROM pg_user u
CROSS JOIN pg_database d
WHERE u.usename LIKE 'proj_%'
  AND d.datistemplate = false
  AND d.datname NOT IN ('postgres', 'template0', 'template1')
ORDER BY u.usename, d.datname;

-- 3. Identify potential cross-project access violations
-- (Users accessing databases that don't match their username pattern)
SELECT 
  'POTENTIAL VIOLATIONS' as section,
  u.usename as username,
  d.datname as unauthorized_database,
  'Cross-project access detected' as violation_type
FROM pg_user u
CROSS JOIN pg_database d
WHERE u.usename LIKE 'proj_%'
  AND d.datistemplate = false
  AND d.datname NOT IN ('postgres', 'template0', 'template1')
  AND d.datname != substring(u.usename from 6) -- Remove 'proj_' prefix
  AND has_database_privilege(u.usename, d.datname, 'CONNECT')
ORDER BY u.usename, d.datname;

-- 4. Check for users with excessive system privileges
SELECT 
  'EXCESSIVE PRIVILEGES' as section,
  usename as username,
  CASE 
    WHEN usesuper THEN 'SUPERUSER'
    WHEN usecreatedb THEN 'CREATEDB'
    WHEN usecreaterole THEN 'CREATEROLE'
    ELSE 'NORMAL'
  END as privilege_level,
  'Review required' as recommendation
FROM pg_user 
WHERE usename LIKE 'proj_%'
  AND (usesuper OR usecreatedb OR usecreaterole)
ORDER BY usename;

-- 5. Summary report
SELECT 
  'SUMMARY' as section,
  COUNT(*) as total_project_users,
  COUNT(CASE WHEN usesuper THEN 1 END) as superusers,
  COUNT(CASE WHEN usecreatedb THEN 1 END) as can_create_db,
  COUNT(CASE WHEN usecreaterole THEN 1 END) as can_create_role
FROM pg_user 
WHERE usename LIKE 'proj_%';
`.trim()
}
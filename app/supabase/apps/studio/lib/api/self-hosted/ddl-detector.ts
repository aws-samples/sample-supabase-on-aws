/**
 * DDL detection for PostgREST schema cache auto-reload.
 *
 * Detects all SQL statements that modify database schema and would require
 * PostgREST to reload its schema cache.
 */

// Strip SQL comments before checking for DDL keywords
function stripComments(sql: string): string {
  // Remove block comments (/* ... */)
  let result = sql.replace(/\/\*[\s\S]*?\*\//g, '')
  // Remove line comments (-- ...)
  result = result.replace(/--[^\n]*/g, '')
  return result
}

// Standard DDL: CREATE/ALTER/DROP/GRANT/REVOKE/COMMENT ON + object type
const DDL_OBJECT_PATTERN =
  /\b(CREATE|ALTER|DROP|GRANT|REVOKE|COMMENT\s+ON)\b\s+(TABLE|SCHEMA|VIEW|MATERIALIZED\s+VIEW|FUNCTION|PROCEDURE|INDEX|TRIGGER|POLICY|TYPE|EXTENSION|SEQUENCE|ROLE|AGGREGATE|OPERATOR|DOMAIN|FOREIGN\s+TABLE|PUBLICATION|SUBSCRIPTION)\b/i

// Standalone DDL commands that don't follow the <verb> <object-type> pattern
const DDL_STANDALONE_PATTERN =
  /\b(REFRESH\s+MATERIALIZED\s+VIEW|TRUNCATE|ALTER\s+DEFAULT\s+PRIVILEGES)\b/i

/**
 * Returns true if the SQL string contains DDL that would invalidate PostgREST schema cache.
 */
export function containsDDL(sql: string): boolean {
  const stripped = stripComments(sql)
  return DDL_OBJECT_PATTERN.test(stripped) || DDL_STANDALONE_PATTERN.test(stripped)
}

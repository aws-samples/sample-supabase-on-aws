"""
DB Admin Lambda - Generic database operations for RDS PostgreSQL.

Supports operations:
  - create_database: Create a new database
  - execute_sql: Execute arbitrary SQL
  - list_databases: List all databases

Invocation:
  aws lambda invoke --function-name db-admin \
    --payload '{"operation":"create_database","params":{"database_name":"kong"}}' \
    response.json
"""

import json
import os
import logging
import boto3
import psycopg2

logger = logging.getLogger()
logger.setLevel(logging.INFO)


def get_rds_credentials(secret_arn=None):
    """Fetch RDS credentials from Secrets Manager."""
    client = boto3.client('secretsmanager')
    arn = secret_arn or os.environ['RDS_SECRET_ARN']
    response = client.get_secret_value(SecretId=arn)
    return json.loads(response['SecretString'])


def get_connection(database='postgres', secret_arn=None):
    """Create a PostgreSQL connection. Optionally override secret_arn to connect to a different RDS instance."""
    creds = get_rds_credentials(secret_arn)
    return psycopg2.connect(
        host=creds['host'],
        port=creds.get('port', 5432),
        dbname=database,
        user=creds['username'],
        password=creds['password'],
        connect_timeout=10,
    )


def create_database(params):
    """Create a new database if it doesn't exist."""
    db_name = params['database_name']
    owner = params.get('owner', 'postgres')

    conn = get_connection('postgres')
    conn.autocommit = True
    cursor = conn.cursor()

    cursor.execute("SELECT 1 FROM pg_database WHERE datname = %s", (db_name,))
    if cursor.fetchone():
        logger.info(f"Database '{db_name}' already exists")
        cursor.close()
        conn.close()
        return {'status': 'exists', 'database': db_name}

    if not db_name.isidentifier():
        raise ValueError(f"Invalid database name: {db_name}")

    cursor.execute(f'CREATE DATABASE "{db_name}" OWNER "{owner}"')
    logger.info(f"Database '{db_name}' created successfully")
    cursor.close()
    conn.close()
    return {'status': 'created', 'database': db_name}


def execute_sql(params):
    """Execute SQL statement(s) on a specified database."""
    database = params.get('database', 'postgres')
    sql = params['sql']
    fetch = params.get('fetch', True)

    conn = get_connection(database)
    conn.autocommit = True
    cursor = conn.cursor()
    cursor.execute(sql)

    result = {'status': 'ok'}
    if fetch:
        try:
            rows = cursor.fetchall()
            columns = [desc[0] for desc in cursor.description] if cursor.description else []
            result['columns'] = columns
            result['rows'] = [list(row) for row in rows]
            result['row_count'] = len(rows)
        except psycopg2.ProgrammingError:
            result['affected_rows'] = cursor.rowcount
    else:
        result['affected_rows'] = cursor.rowcount

    cursor.close()
    conn.close()
    return result


def list_databases(params=None):
    """List all non-template databases."""
    conn = get_connection('postgres')
    cursor = conn.cursor()
    cursor.execute(
        "SELECT datname, pg_database_size(datname) as size_bytes "
        "FROM pg_database WHERE datistemplate = false ORDER BY datname"
    )
    databases = [
        {'name': row[0], 'size_bytes': row[1]}
        for row in cursor.fetchall()
    ]
    cursor.close()
    conn.close()
    return {'status': 'ok', 'databases': databases}


OPERATIONS = {
    'create_database': create_database,
    'execute_sql': execute_sql,
    'list_databases': list_databases,
}


def lambda_handler(event, context):
    """Main Lambda handler."""
    logger.info(f"Received event: {json.dumps(event)}")

    operation = event.get('operation')
    if not operation:
        return {'statusCode': 400, 'error': 'Missing required field: operation'}

    handler_fn = OPERATIONS.get(operation)
    if not handler_fn:
        return {
            'statusCode': 400,
            'error': f'Unknown operation: {operation}',
            'available_operations': list(OPERATIONS.keys()),
        }

    try:
        params = event.get('params', {})
        result = handler_fn(params)
        return {'statusCode': 200, **result}
    except Exception as e:
        logger.error(f"Operation '{operation}' failed: {str(e)}")
        return {'statusCode': 500, 'error': str(e)}

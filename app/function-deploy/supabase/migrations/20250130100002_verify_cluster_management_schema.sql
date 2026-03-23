-- Verification script for cluster management schema
-- This script validates that the schema was created correctly
-- Requirements: 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 3.3

-- Verify _studio schema exists
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = '_studio') THEN
    RAISE EXCEPTION 'Schema _studio does not exist';
  END IF;
END $$;

-- Verify db_instances table exists with correct structure
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables 
    WHERE table_schema = '_studio' AND table_name = 'db_instances'
  ) THEN
    RAISE EXCEPTION 'Table _studio.db_instances does not exist';
  END IF;
END $$;

-- Verify project_allocation_strategies table exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables 
    WHERE table_schema = '_studio' AND table_name = 'project_allocation_strategies'
  ) THEN
    RAISE EXCEPTION 'Table _studio.project_allocation_strategies does not exist';
  END IF;
END $$;

-- Verify db_instances has correct columns
DO $$
DECLARE
  required_columns TEXT[] := ARRAY[
    'id', 'identifier', 'name', 'host', 'port', 'admin_user', 
    'auth_method', 'admin_credential', 'is_management_instance', 
    'region', 'status', 'weight', 'max_databases', 'current_databases',
    'created_at', 'updated_at'
  ];
  col TEXT;
BEGIN
  FOREACH col IN ARRAY required_columns
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns 
      WHERE table_schema = '_studio' 
        AND table_name = 'db_instances' 
        AND column_name = col
    ) THEN
      RAISE EXCEPTION 'Column %.% does not exist', 'db_instances', col;
    END IF;
  END LOOP;
END $$;

-- Verify project_allocation_strategies has correct columns
DO $$
DECLARE
  required_columns TEXT[] := ARRAY[
    'id', 'name', 'strategy_type', 'description', 'config',
    'is_active', 'created_at', 'updated_at'
  ];
  col TEXT;
BEGIN
  FOREACH col IN ARRAY required_columns
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns 
      WHERE table_schema = '_studio' 
        AND table_name = 'project_allocation_strategies' 
        AND column_name = col
    ) THEN
      RAISE EXCEPTION 'Column %.% does not exist', 'project_allocation_strategies', col;
    END IF;
  END LOOP;
END $$;

-- Verify unique constraint on identifier
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'db_instances_identifier_key'
      AND contype = 'u'
  ) THEN
    RAISE EXCEPTION 'Unique constraint on identifier does not exist';
  END IF;
END $$;

-- Verify unique constraint on strategy name
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'project_allocation_strategies_name_key'
      AND contype = 'u'
  ) THEN
    RAISE EXCEPTION 'Unique constraint on strategy name does not exist';
  END IF;
END $$;

-- Verify indexes exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes 
    WHERE schemaname = '_studio' 
      AND tablename = 'db_instances' 
      AND indexname = 'idx_db_instances_host'
  ) THEN
    RAISE EXCEPTION 'Index idx_db_instances_host does not exist';
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes 
    WHERE schemaname = '_studio' 
      AND tablename = 'db_instances' 
      AND indexname = 'idx_db_instances_status'
  ) THEN
    RAISE EXCEPTION 'Index idx_db_instances_status does not exist';
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes 
    WHERE schemaname = '_studio' 
      AND tablename = 'db_instances' 
      AND indexname = 'idx_db_instances_region'
  ) THEN
    RAISE EXCEPTION 'Index idx_db_instances_region does not exist';
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes 
    WHERE schemaname = '_studio' 
      AND tablename = 'project_allocation_strategies' 
      AND indexname = 'idx_allocation_strategies_active'
  ) THEN
    RAISE EXCEPTION 'Index idx_allocation_strategies_active does not exist';
  END IF;
END $$;

-- Verify check constraints
DO $$
BEGIN
  -- Check status constraint
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname LIKE '%status%check%'
      AND contype = 'c'
  ) THEN
    RAISE EXCEPTION 'Check constraint on status does not exist';
  END IF;
  
  -- Check auth_method constraint
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname LIKE '%auth_method%check%'
      AND contype = 'c'
  ) THEN
    RAISE EXCEPTION 'Check constraint on auth_method does not exist';
  END IF;
  
  -- Check strategy_type constraint
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname LIKE '%strategy_type%check%'
      AND contype = 'c'
  ) THEN
    RAISE EXCEPTION 'Check constraint on strategy_type does not exist';
  END IF;
END $$;

-- Verify triggers exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger 
    WHERE tgname = 'update_db_instances_updated_at'
  ) THEN
    RAISE EXCEPTION 'Trigger update_db_instances_updated_at does not exist';
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger 
    WHERE tgname = 'update_allocation_strategies_updated_at'
  ) THEN
    RAISE EXCEPTION 'Trigger update_allocation_strategies_updated_at does not exist';
  END IF;
END $$;

-- If we get here, all verifications passed
DO $$
BEGIN
  RAISE NOTICE 'Schema verification completed successfully';
END $$;

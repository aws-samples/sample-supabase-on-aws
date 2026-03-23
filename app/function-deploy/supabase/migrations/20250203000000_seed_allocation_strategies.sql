-- Migration: Seed Default Allocation Strategies
-- Description: Insert default allocation strategies for cluster management
-- Requirements: 7.1, 7.2

-- Insert default allocation strategies
INSERT INTO _studio.project_allocation_strategies (name, strategy_type, description, config, is_active)
VALUES
  (
    'Manual Assignment',
    'manual',
    'Manually assign projects to specific clusters. Requires explicit cluster selection for each project.',
    '{"allow_override": true}'::jsonb,
    false
  ),
  (
    'Hash-Based Distribution',
    'hash',
    'Distribute projects based on hash of project ID. Ensures consistent assignment and even distribution.',
    '{"hash_algorithm": "md5", "distribution_method": "modulo"}'::jsonb,
    false
  ),
  (
    'Round Robin',
    'round_robin',
    'Assign projects to clusters in a circular order. Simple and ensures even distribution.',
    '{"start_index": 0}'::jsonb,
    true
  ),
  (
    'Weighted Round Robin',
    'weighted_round_robin',
    'Assign projects based on cluster weights. Clusters with higher weights receive more projects.',
    '{"respect_capacity": true, "weight_multiplier": 1.0}'::jsonb,
    false
  ),
  (
    'Least Connections',
    'least_connections',
    'Assign projects to the cluster with the fewest current databases. Balances load dynamically.',
    '{"consider_capacity": true, "threshold_percentage": 80}'::jsonb,
    false
  )
ON CONFLICT (name) DO NOTHING;

-- Add comment
COMMENT ON TABLE _studio.project_allocation_strategies IS 'Stores allocation strategy configurations. Default strategies are seeded on initialization.';

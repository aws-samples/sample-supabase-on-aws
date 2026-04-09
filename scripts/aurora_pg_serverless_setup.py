#!/usr/bin/env python3
"""
Aurora PostgreSQL Serverless v2 Cluster Automated Setup Script

Based on docs/aurora-pg-serverless-setup-guide.md, automates the following steps:
1. Configure environment variables
2. Create/reuse parameter groups
3. Create/reuse security groups
4. Create Aurora Serverless v2 cluster (IO/Optimized)
5. Create Writer instance (and optional Reader Replicas)
6. Store credentials in Secrets Manager
7. Register with Supabase Tenant Manager
8. Verify registration success

Usage:
    python scripts/aurora_pg_serverless_setup.py --env test --config config.json
    python scripts/aurora_pg_serverless_setup.py --env prod --config config.json --dry-run

    # Production (minimal flags - VPC and SGs are auto-discovered):
    python scripts/aurora_pg_serverless_setup.py --env prod \\
        --tm-url https://studio.test.uk

    # Production (explicit VPC and SG IDs):
    python scripts/aurora_pg_serverless_setup.py --env prod \\
        --config config.json \\
        --vpc-id vpc-xxx \\
        --tm-sg sg-aaa111 --lambda-sg sg-bbb222 \\
        --pg-meta-sg sg-ccc333 --auth-sg sg-ddd444 \\
        --tm-url https://studio.test.uk
"""

import argparse
import json
import logging
import os
import secrets
import subprocess
import sys
from dataclasses import dataclass
from typing import Optional

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger(__name__)


# ============================================
# Configuration
# ============================================

@dataclass
class EnvConfig:
    """Environment-specific configuration"""
    env_type: str  # "prod" or "test"
    min_acu: float = 0.5
    max_acu: float = 4
    reader_count: int = 0
    deletion_protection: bool = False
    backup_retention: int = 7

    def __post_init__(self):
        if self.env_type == "prod":
            self.min_acu = 2
            self.max_acu = 16
            self.reader_count = 1
            self.deletion_protection = True
            self.backup_retention = 30
        else:
            self.min_acu = 0.5
            self.max_acu = 4
            self.reader_count = 0
            self.deletion_protection = False
            self.backup_retention = 7


@dataclass
class ClusterConfig:
    """Cluster configuration"""
    region: str = "us-east-1"
    vpc_id: str = ""
    subnet_group: str = "supabase-rds-subnet-group"
    cluster_id: str = ""
    instance_id: str = ""
    db_master_user: str = "postgres"
    db_password: str = ""
    db_port: int = 5432
    engine_version: str = "16.8"
    cluster_pg_name: str = ""
    db_pg_name: str = ""
    worker_sg_id: str = ""
    # Source security groups for ingress rules (used when creating new SG)
    tm_sg_id: str = ""
    lambda_sg_id: str = ""
    pg_meta_sg_id: str = ""
    auth_sg_id: str = ""
    # Tenant Manager
    tm_base_url: str = ""
    admin_api_key: str = ""
    # Reuse flags
    reuse_cluster_pg: bool = False
    reuse_db_pg: bool = False
    reuse_sg: bool = False


# ============================================
# AWS CLI wrapper
# ============================================

def run_aws(args: list[str], region: str, capture: bool = True,
            dry_run: bool = False) -> Optional[str]:
    """Execute an AWS CLI command and return output"""
    cmd = ["aws"] + args + ["--region", region, "--output", "json"]
    logger.info(f"Running: {' '.join(cmd)}")

    if dry_run:
        logger.info("[DRY-RUN] Skipping actual execution")
        return None

    result = subprocess.run(cmd, capture_output=capture, text=True)
    if result.returncode != 0:
        stderr = result.stderr.strip() if result.stderr else ""
        raise RuntimeError(f"AWS CLI failed (rc={result.returncode}): {stderr}")
    return result.stdout.strip() if capture else None


def run_aws_json(args: list[str], region: str,
                 dry_run: bool = False) -> Optional[dict]:
    """Execute an AWS CLI command and parse JSON output"""
    output = run_aws(args, region, dry_run=dry_run)
    if output is None:
        return None
    return json.loads(output) if output else {}


# ============================================
# Step implementations
# ============================================

def generate_password() -> str:
    """Generate an RDS-compatible strong password (hex only, no special chars)"""
    return secrets.token_hex(24)


def discover_vpc(cfg: ClusterConfig, dry_run: bool) -> str:
    """Auto-discover the Supabase VPC ID"""
    if cfg.vpc_id:
        logger.info(f"Using specified VPC: {cfg.vpc_id}")
        return cfg.vpc_id

    logger.info("Auto-discovering VPC...")
    result = run_aws_json([
        "ec2", "describe-vpcs",
        "--filters", "Name=tag:Name,Values=*supabase*",
        "--query", "Vpcs[0].VpcId",
    ], cfg.region, dry_run=dry_run)

    if dry_run:
        return "vpc-dry-run"
    if not result:
        raise RuntimeError(
            "No VPC found with 'supabase' tag. Please specify --vpc-id manually")
    vpc_id = result if isinstance(result, str) else str(result)
    logger.info(f"Discovered VPC: {vpc_id}")
    return vpc_id


def discover_security_groups(cfg: ClusterConfig, dry_run: bool):
    """Auto-discover service security groups from the existing worker cluster.

    Looks up the existing supabase-worker-cluster to find its VPC security
    groups, then queries ECS services / security groups in the VPC whose
    names contain known service keywords (tenant-manager, lambda, meta, auth).
    """
    if cfg.reuse_sg:
        return  # already have a full SG to reuse

    # If all four source SGs are already provided, nothing to discover
    if all([cfg.tm_sg_id, cfg.lambda_sg_id,
            cfg.pg_meta_sg_id, cfg.auth_sg_id]):
        return

    logger.info("Auto-discovering service security groups from VPC...")

    if dry_run:
        logger.info("[DRY-RUN] Skipping SG discovery")
        return

    # Fetch all security groups in the VPC
    result = run_aws_json([
        "ec2", "describe-security-groups",
        "--filters", f"Name=vpc-id,Values={cfg.vpc_id}",
        "--query", "SecurityGroups[*].{ID:GroupId,Name:GroupName}",
    ], cfg.region)

    if not result:
        logger.warning("No security groups found in VPC, "
                        "ingress rules will be skipped")
        return

    # Build a name -> id lookup (lowercase for matching)
    sg_map = {sg["Name"].lower(): sg["ID"] for sg in result if sg.get("Name")}

    def find_sg(keywords: list[str]) -> str:
        """Find first SG whose name contains any of the keywords"""
        for name, sg_id in sg_map.items():
            if any(kw in name for kw in keywords):
                return sg_id
        return ""

    if not cfg.tm_sg_id:
        cfg.tm_sg_id = find_sg(["tenantmanagersg", "tenant-manager",
                                 "tenantmanager", "tm-"])
        if cfg.tm_sg_id:
            logger.info(f"  Discovered Tenant Manager SG: {cfg.tm_sg_id}")

    if not cfg.lambda_sg_id:
        cfg.lambda_sg_id = find_sg(["lambdasg", "lambda-sg", "lambda"])
        if cfg.lambda_sg_id:
            logger.info(f"  Discovered Lambda SG: {cfg.lambda_sg_id}")

    if not cfg.pg_meta_sg_id:
        cfg.pg_meta_sg_id = find_sg(["postgresmetasg", "postgres-meta",
                                      "pg-meta", "pgmeta"])
        if cfg.pg_meta_sg_id:
            logger.info(f"  Discovered postgres-meta SG: {cfg.pg_meta_sg_id}")

    if not cfg.auth_sg_id:
        cfg.auth_sg_id = find_sg(["authsg-", "auth-sg", "auth-service",
                                   "gotrue"])
        if not cfg.auth_sg_id:
            # Broader match, but exclude SGs that are clearly not auth
            # (e.g. studioalbsg, functiondeploysg)
            for name, sg_id in sg_map.items():
                if "authsg" in name and "alb" not in name:
                    cfg.auth_sg_id = sg_id
                    break
        if cfg.auth_sg_id:
            logger.info(f"  Discovered Auth SG: {cfg.auth_sg_id}")

    # Also try: reuse the existing worker cluster's SG directly
    if not any([cfg.tm_sg_id, cfg.lambda_sg_id,
                cfg.pg_meta_sg_id, cfg.auth_sg_id]):
        logger.info("  Falling back: looking up existing worker cluster SG...")
        worker = run_aws_json([
            "rds", "describe-db-clusters",
            "--query", "DBClusters[?contains(DBClusterIdentifier,"
                       "'worker')].VpcSecurityGroups[*].VpcSecurityGroupId",
        ], cfg.region)
        if worker and isinstance(worker, list):
            # Flatten nested lists
            flat = [sg for sublist in worker for sg in (
                sublist if isinstance(sublist, list) else [sublist])]
            if flat:
                existing_sg = flat[0]
                logger.info(f"  Found existing worker cluster SG: "
                             f"{existing_sg}")
                logger.info("  Tip: you can pass --worker-sg "
                             f"{existing_sg} to reuse it directly")


def _pg_group_exists(group_type: str, name: str, region: str) -> bool:
    """Check if a parameter group already exists.
    group_type: 'cluster' or 'db'
    """
    try:
        if group_type == "cluster":
            run_aws([
                "rds", "describe-db-cluster-parameter-groups",
                "--db-cluster-parameter-group-name", name,
            ], region)
        else:
            run_aws([
                "rds", "describe-db-parameter-groups",
                "--db-parameter-group-name", name,
            ], region)
        return True
    except RuntimeError:
        return False


def step_create_parameter_groups(cfg: ClusterConfig, dry_run: bool):
    """Step 2: Create custom parameter groups"""
    logger.info("=" * 60)
    logger.info("Step 2: Create/reuse parameter groups")
    logger.info("=" * 60)

    # --- Cluster parameter group ---
    if cfg.reuse_cluster_pg:
        logger.info(f"Reusing existing cluster parameter group: {cfg.cluster_pg_name}")
    else:
        cfg.cluster_pg_name = f"{cfg.cluster_id}-cluster-pg"

        if not dry_run and _pg_group_exists("cluster", cfg.cluster_pg_name, cfg.region):
            logger.info(f"Cluster parameter group already exists: "
                         f"{cfg.cluster_pg_name}, updating parameters...")
        else:
            logger.info(f"Creating cluster parameter group: {cfg.cluster_pg_name}")
            try:
                run_aws([
                    "rds", "create-db-cluster-parameter-group",
                    "--db-cluster-parameter-group-name", cfg.cluster_pg_name,
                    "--db-parameter-group-family", "aurora-postgresql16",
                    "--description",
                    f"Cluster PG for Supabase Aurora cluster {cfg.cluster_id}",
                ], cfg.region, dry_run=dry_run)
            except RuntimeError as e:
                if "AlreadyExists" in str(e):
                    logger.info("Cluster parameter group already exists, "
                                 "continuing with modify")
                else:
                    raise

        logger.info("Setting cluster parameters...")
        run_aws([
            "rds", "modify-db-cluster-parameter-group",
            "--db-cluster-parameter-group-name", cfg.cluster_pg_name,
            "--parameters",
            "ParameterName=shared_preload_libraries,"
            "ParameterValue='pg_stat_statements,pg_cron',"
            "ApplyMethod=pending-reboot",
            "ParameterName=rds.logical_replication,"
            "ParameterValue=1,ApplyMethod=pending-reboot",
            "ParameterName=max_slot_wal_keep_size,"
            "ParameterValue=1024,ApplyMethod=immediate",
        ], cfg.region, dry_run=dry_run)

    # --- DB instance parameter group ---
    if cfg.reuse_db_pg:
        logger.info(f"Reusing existing DB parameter group: {cfg.db_pg_name}")
    else:
        cfg.db_pg_name = f"{cfg.cluster_id}-db-pg"

        if not dry_run and _pg_group_exists("db", cfg.db_pg_name, cfg.region):
            logger.info(f"DB parameter group already exists: "
                         f"{cfg.db_pg_name}, updating parameters...")
        else:
            logger.info(f"Creating DB parameter group: {cfg.db_pg_name}")
            try:
                run_aws([
                    "rds", "create-db-parameter-group",
                    "--db-parameter-group-name", cfg.db_pg_name,
                    "--db-parameter-group-family", "aurora-postgresql16",
                    "--description",
                    f"DB PG for Supabase Aurora instances in {cfg.cluster_id}",
                ], cfg.region, dry_run=dry_run)
            except RuntimeError as e:
                if "AlreadyExists" in str(e):
                    logger.info("DB parameter group already exists, "
                                 "continuing with modify")
                else:
                    raise

        logger.info("Setting instance parameters...")
        run_aws([
            "rds", "modify-db-parameter-group",
            "--db-parameter-group-name", cfg.db_pg_name,
            "--parameters",
            "ParameterName=log_min_duration_statement,"
            "ParameterValue=1000,ApplyMethod=immediate",
            "ParameterName=auto_explain.log_min_duration,"
            "ParameterValue=1000,ApplyMethod=immediate",
        ], cfg.region, dry_run=dry_run)

    logger.info("Parameter groups ready")


def step_create_security_group(cfg: ClusterConfig, dry_run: bool):
    """Step 3: Create/reuse security group"""
    logger.info("=" * 60)
    logger.info("Step 3: Create/reuse security group")
    logger.info("=" * 60)

    if cfg.reuse_sg:
        logger.info(f"Reusing existing security group: {cfg.worker_sg_id}")
        return

    logger.info("Creating new security group...")
    sg_name = f"{cfg.cluster_id}-sg"

    # Check if SG with this name already exists in the VPC
    existing_sg_id = None
    if not dry_run:
        try:
            result = run_aws_json([
                "ec2", "describe-security-groups",
                "--filters",
                f"Name=group-name,Values={sg_name}",
                f"Name=vpc-id,Values={cfg.vpc_id}",
                "--query", "SecurityGroups[0].GroupId",
            ], cfg.region)
            if result and isinstance(result, str):
                existing_sg_id = result
        except RuntimeError:
            pass

    if existing_sg_id:
        cfg.worker_sg_id = existing_sg_id
        logger.info(f"Security group already exists: {cfg.worker_sg_id}, "
                     "reusing it")
    else:
        try:
            output = run_aws([
                "ec2", "create-security-group",
                "--group-name", sg_name,
                "--description",
                f"SG for Supabase Aurora cluster {cfg.cluster_id}",
                "--vpc-id", cfg.vpc_id,
                "--query", "GroupId",
                "--output", "text",
            ], cfg.region, dry_run=dry_run)

            if dry_run:
                cfg.worker_sg_id = "sg-dry-run"
            else:
                cfg.worker_sg_id = output.strip().strip('"')
            logger.info(f"Security group created: {cfg.worker_sg_id}")
        except RuntimeError as e:
            if "InvalidGroup.Duplicate" in str(e):
                logger.info(f"Security group {sg_name} already exists, "
                             "looking up its ID...")
                result = run_aws_json([
                    "ec2", "describe-security-groups",
                    "--filters",
                    f"Name=group-name,Values={sg_name}",
                    f"Name=vpc-id,Values={cfg.vpc_id}",
                    "--query", "SecurityGroups[0].GroupId",
                ], cfg.region)
                cfg.worker_sg_id = result if isinstance(result, str) else str(result)
            else:
                raise

    # Add ingress rules
    source_sgs = {
        "Tenant Manager": cfg.tm_sg_id,
        "Lambda": cfg.lambda_sg_id,
        "postgres-meta": cfg.pg_meta_sg_id,
        "Auth": cfg.auth_sg_id,
    }

    for name, sg_id in source_sgs.items():
        if not sg_id:
            logger.warning(f"Skipping {name} ingress rule (no SG ID provided)")
            continue
        logger.info(f"Adding ingress rule: {name} ({sg_id}) -> port {cfg.db_port}")
        try:
            run_aws([
                "ec2", "authorize-security-group-ingress",
                "--group-id", cfg.worker_sg_id,
                "--protocol", "tcp",
                "--port", str(cfg.db_port),
                "--source-group", sg_id,
            ], cfg.region, dry_run=dry_run)
        except RuntimeError as e:
            if "InvalidPermission.Duplicate" in str(e):
                logger.info(f"Ingress rule already exists, skipping: {name}")
            else:
                raise

    logger.info("Security group configuration complete")


def step_create_cluster(cfg: ClusterConfig, env: EnvConfig, dry_run: bool):
    """Step 4: Create Aurora Serverless v2 cluster (IO/Optimized)"""
    logger.info("=" * 60)
    logger.info("Step 4: Create Aurora Serverless v2 cluster (IO/Optimized)")
    logger.info("=" * 60)

    # 5.1 Create cluster
    cluster_exists = False
    if not dry_run:
        try:
            run_aws([
                "rds", "describe-db-clusters",
                "--db-cluster-identifier", cfg.cluster_id,
            ], cfg.region)
            cluster_exists = True
            logger.info(f"Cluster already exists: {cfg.cluster_id}, "
                         "skipping creation")
        except RuntimeError:
            pass

    if not cluster_exists:
        create_args = [
            "rds", "create-db-cluster",
            "--db-cluster-identifier", cfg.cluster_id,
            "--engine", "aurora-postgresql",
            "--engine-version", cfg.engine_version,
            "--master-username", cfg.db_master_user,
            "--master-user-password", cfg.db_password,
            "--db-subnet-group-name", cfg.subnet_group,
            "--vpc-security-group-ids", cfg.worker_sg_id,
            "--db-cluster-parameter-group-name", cfg.cluster_pg_name,
            "--storage-type", "aurora-iopt1",
            "--storage-encrypted",
            "--serverless-v2-scaling-configuration",
            f"MinCapacity={env.min_acu},MaxCapacity={env.max_acu}",
            "--backup-retention-period", str(env.backup_retention),
            "--database-name", "postgres",
        ]
        if env.deletion_protection:
            create_args.append("--deletion-protection")

        try:
            run_aws(create_args, cfg.region, dry_run=dry_run)
            logger.info("Cluster creation command submitted")
        except RuntimeError as e:
            if "DBClusterAlreadyExistsFault" in str(e):
                logger.info("Cluster already exists, continuing")
                cluster_exists = True
            else:
                raise

    # 5.2 Wait for cluster to become available
    if not dry_run:
        logger.info("Waiting for cluster to become available (~5-10 min)...")
        run_aws([
            "rds", "wait", "db-cluster-available",
            "--db-cluster-identifier", cfg.cluster_id,
        ], cfg.region, dry_run=dry_run)
        logger.info("Cluster is now available")

    # 5.3 Enable Database Insights
    logger.info("Enabling Database Insights...")
    run_aws([
        "rds", "modify-db-cluster",
        "--db-cluster-identifier", cfg.cluster_id,
        "--enable-performance-insights",
        "--database-insights-mode", "standard",
        "--performance-insights-retention-period", "31",
        "--apply-immediately",
    ], cfg.region, dry_run=dry_run)

    # 5.4 Create Writer instance
    logger.info(f"Creating Writer instance: {cfg.instance_id}")
    try:
        run_aws([
            "rds", "create-db-instance",
            "--db-instance-identifier", cfg.instance_id,
            "--db-instance-class", "db.serverless",
            "--engine", "aurora-postgresql",
            "--db-cluster-identifier", cfg.cluster_id,
            "--db-parameter-group-name", cfg.db_pg_name,
        ], cfg.region, dry_run=dry_run)
    except RuntimeError as e:
        if "DBInstanceAlreadyExists" in str(e):
            logger.info(f"Writer instance already exists: {cfg.instance_id}, "
                         "skipping")
        else:
            raise

    # 5.5 Wait for Writer instance
    if not dry_run:
        logger.info("Waiting for Writer instance to become available (~5-10 min)...")
        run_aws([
            "rds", "wait", "db-instance-available",
            "--db-instance-identifier", cfg.instance_id,
        ], cfg.region)
        logger.info("Writer instance is now available")

    # 5.6 Verify cluster status
    logger.info("Verifying cluster status...")
    if not dry_run:
        result = run_aws_json([
            "rds", "describe-db-clusters",
            "--db-cluster-identifier", cfg.cluster_id,
            "--query", "DBClusters[0].{Status:Status,Engine:Engine,"
                       "EngineVersion:EngineVersion,StorageType:StorageType,"
                       "Endpoint:Endpoint,Port:Port}",
        ], cfg.region)
        logger.info(f"Cluster status: {json.dumps(result, indent=2)}")


def get_cluster_endpoints(cfg: ClusterConfig,
                          dry_run: bool) -> tuple[str, str]:
    """Retrieve cluster writer and reader endpoints"""
    if dry_run:
        return ("dry-run-endpoint.cluster-xxx.rds.amazonaws.com",
                "dry-run-endpoint.cluster-ro-xxx.rds.amazonaws.com")

    writer = run_aws([
        "rds", "describe-db-clusters",
        "--db-cluster-identifier", cfg.cluster_id,
        "--query", "DBClusters[0].Endpoint",
        "--output", "text",
    ], cfg.region)

    reader = run_aws([
        "rds", "describe-db-clusters",
        "--db-cluster-identifier", cfg.cluster_id,
        "--query", "DBClusters[0].ReaderEndpoint",
        "--output", "text",
    ], cfg.region)

    logger.info(f"Writer endpoint: {writer}")
    logger.info(f"Reader endpoint: {reader}")
    return writer.strip(), reader.strip()


def step_create_readers(cfg: ClusterConfig, env: EnvConfig, dry_run: bool):
    """Step 5: Create Reader Replicas (prod only)"""
    logger.info("=" * 60)
    logger.info("Step 5: Create Reader Replicas")
    logger.info("=" * 60)

    if env.reader_count <= 0:
        logger.info("Test environment, skipping Reader creation")
        return

    for i in range(1, env.reader_count + 1):
        reader_id = f"{cfg.cluster_id}-reader-{i}"
        logger.info(f"Creating Reader {i}: {reader_id}")

        try:
            run_aws([
                "rds", "create-db-instance",
                "--db-instance-identifier", reader_id,
                "--db-instance-class", "db.serverless",
                "--engine", "aurora-postgresql",
                "--db-cluster-identifier", cfg.cluster_id,
                "--db-parameter-group-name", cfg.db_pg_name,
            ], cfg.region, dry_run=dry_run)
        except RuntimeError as e:
            if "DBInstanceAlreadyExists" in str(e):
                logger.info(f"Reader {reader_id} already exists, skipping")
            else:
                raise

        if not dry_run:
            logger.info(f"Waiting for Reader {i} to become available...")
            run_aws([
                "rds", "wait", "db-instance-available",
                "--db-instance-identifier", reader_id,
            ], cfg.region)
            logger.info(f"Reader {i} is now available")

    # Verify cluster members
    if not dry_run:
        result = run_aws_json([
            "rds", "describe-db-clusters",
            "--db-cluster-identifier", cfg.cluster_id,
            "--query", "DBClusters[0].DBClusterMembers[*]."
                       "{InstanceID:DBInstanceIdentifier,"
                       "IsWriter:IsClusterWriter}",
        ], cfg.region)
        logger.info(f"Cluster members: {json.dumps(result, indent=2)}")


def step_store_credentials(cfg: ClusterConfig, cluster_endpoint: str,
                           reader_endpoint: str, dry_run: bool) -> str:
    """Step 6: Store credentials in Secrets Manager"""
    logger.info("=" * 60)
    logger.info("Step 6: Store credentials in Secrets Manager")
    logger.info("=" * 60)

    secret_name = f"supabase/{cfg.cluster_id}/credentials"
    secret_value = json.dumps({
        "username": cfg.db_master_user,
        "password": cfg.db_password,
        "engine": "postgres",
        "host": cluster_endpoint,
        "reader_host": reader_endpoint,
        "port": cfg.db_port,
        "dbClusterIdentifier": cfg.cluster_id,
    })

    secret_arn = None
    try:
        output = run_aws([
            "secretsmanager", "create-secret",
            "--name", secret_name,
            "--description",
            f"Credentials for Supabase Aurora cluster {cfg.cluster_id}",
            "--secret-string", secret_value,
            "--query", "ARN",
            "--output", "text",
        ], cfg.region, dry_run=dry_run)
        secret_arn = output.strip() if output else None
    except RuntimeError as e:
        if "ResourceExistsException" in str(e):
            logger.info(f"Secret already exists: {secret_name}, "
                         "updating value...")
            run_aws([
                "secretsmanager", "put-secret-value",
                "--secret-id", secret_name,
                "--secret-string", secret_value,
            ], cfg.region, dry_run=dry_run)
            # Retrieve ARN
            if not dry_run:
                arn_output = run_aws([
                    "secretsmanager", "describe-secret",
                    "--secret-id", secret_name,
                    "--query", "ARN",
                    "--output", "text",
                ], cfg.region)
                secret_arn = arn_output.strip() if arn_output else None
        else:
            raise

    if not secret_arn:
        secret_arn = "arn:aws:secretsmanager:dry-run"
    logger.info(f"Secret ARN: {secret_arn}")

    # Verify stored credentials
    if not dry_run:
        logger.info("Verifying stored credentials...")
        verify = run_aws([
            "secretsmanager", "get-secret-value",
            "--secret-id", secret_arn,
            "--query", "SecretString",
            "--output", "text",
        ], cfg.region)
        stored = json.loads(verify)
        assert stored["username"] == cfg.db_master_user, "Username mismatch"
        assert stored["host"] == cluster_endpoint, "Host mismatch"
        logger.info("Credentials verification passed")

    return secret_arn


def step_get_admin_api_key(cfg: ClusterConfig, dry_run: bool) -> str:
    """Retrieve Tenant Manager Admin API Key from Secrets Manager"""
    if cfg.admin_api_key:
        return cfg.admin_api_key

    logger.info("Retrieving Admin API Key from Secrets Manager...")
    output = run_aws([
        "secretsmanager", "get-secret-value",
        "--secret-id", "supabase/admin-api-key",
        "--query", "SecretString",
        "--output", "text",
    ], cfg.region, dry_run=dry_run)

    if dry_run:
        return "dry-run-api-key"
    return output.strip()


def step_register_rds_instance(cfg: ClusterConfig, cluster_endpoint: str,
                               api_key: str,
                               dry_run: bool) -> Optional[dict]:
    """Step 7: Register RDS instance with Supabase Tenant Manager"""
    logger.info("=" * 60)
    logger.info("Step 7: Register RDS instance with Tenant Manager")
    logger.info("=" * 60)

    url = f"{cfg.tm_base_url}/admin/v1/rds-instances"
    payload = {
        "identifier": cfg.cluster_id.replace("supabase-", ""),
        "name": f"Aurora Cluster ({cfg.cluster_id}, IO/Optimized, "
                f"PG {cfg.engine_version})",
        "host": cluster_endpoint,
        "port": cfg.db_port,
        "admin_user": cfg.db_master_user,
        "admin_password": cfg.db_password,
        "region": cfg.region,
        "max_databases": 100,
        "weight": 1,
    }

    # Log payload without password
    safe_payload = {k: v for k, v in payload.items() if k != "admin_password"}
    logger.info(f"Registration endpoint: {url}")
    logger.info(f"Payload: {json.dumps(safe_payload, indent=2)}")

    if dry_run:
        logger.info("[DRY-RUN] Skipping API call")
        return {"id": 0, "status": "dry-run"}

    import urllib.request
    import urllib.error

    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            status_code = resp.status
            body = json.loads(resp.read().decode("utf-8"))
            logger.info(f"Registration successful (HTTP {status_code})")
            logger.info(f"Response: {json.dumps(body, indent=2)}")
            return body
    except urllib.error.HTTPError as e:
        error_body = e.read().decode("utf-8") if e.fp else ""
        logger.error(f"Registration failed (HTTP {e.code}): {error_body}")
        _print_error_help(e.code)
        raise RuntimeError(
            f"Tenant Manager registration failed: HTTP {e.code}")


def _print_error_help(status_code: int):
    """Print troubleshooting suggestions for common errors"""
    help_map = {
        400: "Check that the request body contains all required fields "
             "(identifier, name, host, port, admin_user, admin_password, "
             "region, max_databases)",
        401: "Invalid API Key. Re-fetch from Secrets Manager: "
             "supabase/admin-api-key",
        409: "Identifier already exists. Use a different identifier or "
             "delete the existing instance first",
        500: "Server error. Check Tenant Manager logs: "
             "aws logs tail /ecs/supabase --filter-pattern tenant-manager",
    }
    if status_code in help_map:
        logger.info(f"Troubleshooting: {help_map[status_code]}")


def step_verify_registration(cfg: ClusterConfig, api_key: str,
                             instance_id: Optional[int],
                             dry_run: bool) -> bool:
    """Step 8: Verify registration was successful"""
    logger.info("=" * 60)
    logger.info("Step 8: Verify registration result")
    logger.info("=" * 60)

    if dry_run:
        logger.info("[DRY-RUN] Skipping verification")
        return True

    import urllib.request

    # 1. List all RDS instances
    url = f"{cfg.tm_base_url}/admin/v1/rds-instances"
    req = urllib.request.Request(
        url, headers={"Authorization": f"Bearer {api_key}"})

    with urllib.request.urlopen(req, timeout=30) as resp:
        instances = json.loads(resp.read().decode("utf-8"))

    logger.info(f"Total registered RDS instances: {len(instances)}")

    # 2. Find the newly registered instance
    expected_identifier = cfg.cluster_id.replace("supabase-", "")
    found = None
    for inst in instances:
        logger.info(
            f"  - [{inst.get('id')}] {inst.get('identifier')} "
            f"({inst.get('status')}): "
            f"{inst.get('current_databases', 0)}/"
            f"{inst.get('max_databases')} databases")
        if inst.get("identifier") == expected_identifier:
            found = inst

    if not found and instance_id:
        # Query single instance by ID
        detail_url = (f"{cfg.tm_base_url}/admin/v1/"
                      f"rds-instances/{instance_id}")
        req2 = urllib.request.Request(
            detail_url, headers={"Authorization": f"Bearer {api_key}"})
        with urllib.request.urlopen(req2, timeout=30) as resp2:
            found = json.loads(resp2.read().decode("utf-8"))

    if found:
        logger.info("=" * 60)
        logger.info("PASS: New instance successfully registered "
                     "with Tenant Manager")
        logger.info(f"  Instance ID:    {found.get('id')}")
        logger.info(f"  Identifier:     {found.get('identifier')}")
        logger.info(f"  Status:         {found.get('status')}")
        logger.info(f"  Host:           {found.get('host')}")
        logger.info(f"  Region:         {found.get('region')}")
        logger.info(f"  Max databases:  {found.get('max_databases')}")
        logger.info("=" * 60)
        return True
    else:
        logger.error("FAIL: Newly registered instance not found "
                      "in Tenant Manager")
        return False


# ============================================
# Main flow
# ============================================

def load_project_config(config_path: str) -> dict:
    """Load project config.json"""
    with open(config_path) as f:
        return json.load(f)


def build_config(args, project_cfg: dict) -> tuple[ClusterConfig, EnvConfig]:
    """Build runtime configuration from CLI args and project config"""
    env = EnvConfig(env_type=args.env)
    cfg = ClusterConfig()

    # From project config
    cfg.region = project_cfg.get("project", {}).get("region", "us-east-1")
    cfg.engine_version = args.engine_version or "16.8"

    # Cluster identity
    cfg.cluster_id = (args.cluster_id
                      or f"supabase-new-worker-cluster-{args.env}")
    cfg.instance_id = f"{cfg.cluster_id}-writer"

    # Password
    cfg.db_password = args.password or generate_password()

    # Networking
    cfg.vpc_id = args.vpc_id or ""
    cfg.subnet_group = args.subnet_group or "supabase-rds-subnet-group"

    # Parameter group reuse
    if args.cluster_pg:
        cfg.cluster_pg_name = args.cluster_pg
        cfg.reuse_cluster_pg = True
    if args.db_pg:
        cfg.db_pg_name = args.db_pg
        cfg.reuse_db_pg = True

    # Security group reuse
    if args.worker_sg:
        cfg.worker_sg_id = args.worker_sg
        cfg.reuse_sg = True
    else:
        cfg.tm_sg_id = args.tm_sg or ""
        cfg.lambda_sg_id = args.lambda_sg or ""
        cfg.pg_meta_sg_id = args.pg_meta_sg or ""
        cfg.auth_sg_id = args.auth_sg or ""

    # Tenant Manager
    base_domain = project_cfg.get("domain", {}).get("baseDomain", "")
    cfg.tm_base_url = args.tm_url or (
        f"https://studio.{base_domain}" if base_domain else "")
    cfg.admin_api_key = args.admin_api_key or ""

    return cfg, env


def main():
    parser = argparse.ArgumentParser(
        description="Aurora PostgreSQL Serverless v2 cluster automated setup",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Test environment dry-run
  python scripts/aurora_pg_serverless_setup.py --env test --dry-run

  # Test environment with existing parameter groups and security group
  python scripts/aurora_pg_serverless_setup.py --env test \\
    --cluster-pg existing-cluster-pg --db-pg existing-db-pg \\
    --worker-sg sg-0123456789abcdef0

  # Production environment (create all resources)
  python scripts/aurora_pg_serverless_setup.py --env prod \\
    --vpc-id vpc-xxx --tm-sg sg-aaa --lambda-sg sg-bbb \\
    --pg-meta-sg sg-ccc --auth-sg sg-ddd \\
    --tm-url https://studio.example.com
        """,
    )

    # Required
    parser.add_argument("--env", choices=["prod", "test"], required=True,
                        help="Environment type: prod or test")

    # Project config
    parser.add_argument("--config", default="config.json",
                        help="Path to project config.json (default: config.json)")

    # Cluster settings
    parser.add_argument("--cluster-id",
                        help="Cluster identifier "
                             "(default: supabase-new-worker-cluster-{env})")
    parser.add_argument("--engine-version", default="16.8",
                        help="Engine version (default: 16.8)")
    parser.add_argument("--password",
                        help="Database password (default: auto-generated)")

    # Networking
    parser.add_argument("--vpc-id",
                        help="VPC ID (default: auto-discover)")
    parser.add_argument("--subnet-group",
                        default="supabase-rds-subnet-group",
                        help="RDS subnet group name")

    # Parameter group reuse
    parser.add_argument("--cluster-pg",
                        help="Reuse existing cluster parameter group name")
    parser.add_argument("--db-pg",
                        help="Reuse existing DB parameter group name")

    # Security groups
    parser.add_argument("--worker-sg",
                        help="Reuse existing security group ID")
    parser.add_argument("--tm-sg",
                        help="Tenant Manager SG ID "
                             "(default: auto-discover from VPC)")
    parser.add_argument("--lambda-sg",
                        help="Lambda SG ID "
                             "(default: auto-discover from VPC)")
    parser.add_argument("--pg-meta-sg",
                        help="postgres-meta SG ID "
                             "(default: auto-discover from VPC)")
    parser.add_argument("--auth-sg",
                        help="Auth service SG ID "
                             "(default: auto-discover from VPC)")

    # Tenant Manager
    parser.add_argument("--tm-url",
                        help="Tenant Manager base URL")
    parser.add_argument("--admin-api-key",
                        help="Admin API Key "
                             "(default: fetched from Secrets Manager)")

    # Control flags
    parser.add_argument("--dry-run", action="store_true",
                        help="Print commands only, do not execute")
    parser.add_argument("--skip-register", action="store_true",
                        help="Skip Tenant Manager registration step")

    args = parser.parse_args()

    # Load project config
    project_cfg = {}
    if os.path.exists(args.config):
        project_cfg = load_project_config(args.config)
        logger.info(f"Loaded project config: {args.config}")
    else:
        logger.warning(f"Project config not found: {args.config}, "
                        "using defaults")

    cfg, env = build_config(args, project_cfg)
    dry_run = args.dry_run

    # Print configuration summary
    logger.info("=" * 60)
    logger.info("Aurora PostgreSQL Serverless v2 Cluster Setup")
    logger.info("=" * 60)
    logger.info(f"Environment:       {env.env_type}")
    logger.info(f"Cluster ID:        {cfg.cluster_id}")
    logger.info(f"Engine version:    {cfg.engine_version}")
    logger.info(f"ACU range:         {env.min_acu} - {env.max_acu}")
    logger.info(f"Reader count:      {env.reader_count}")
    logger.info(f"Delete protection: {env.deletion_protection}")
    logger.info(f"Backup retention:  {env.backup_retention} days")
    logger.info(f"Region:            {cfg.region}")
    logger.info(f"Dry-Run:           {dry_run}")
    if not args.password:
        logger.info(f"Password (auto):   {cfg.db_password}")
        logger.info("WARNING: Save this password, it is needed in later steps")
    logger.info("=" * 60)

    try:
        # Step 1: Discover VPC
        cfg.vpc_id = discover_vpc(cfg, dry_run)

        # Step 2: Parameter groups
        step_create_parameter_groups(cfg, dry_run)

        # Auto-discover service SGs if not provided
        discover_security_groups(cfg, dry_run)

        # Step 3: Security group
        step_create_security_group(cfg, dry_run)

        # Step 4: Create cluster and Writer instance
        step_create_cluster(cfg, env, dry_run)

        # Get endpoints
        cluster_endpoint, reader_endpoint = get_cluster_endpoints(
            cfg, dry_run)

        # Step 5: Reader Replicas
        step_create_readers(cfg, env, dry_run)

        # Step 6: Secrets Manager
        secret_arn = step_store_credentials(
            cfg, cluster_endpoint, reader_endpoint, dry_run)

        # Step 7 & 8: Register with Tenant Manager and verify
        if args.skip_register:
            logger.info("Skipping Tenant Manager registration "
                         "(--skip-register)")
        else:
            if not cfg.tm_base_url:
                logger.warning("No Tenant Manager URL specified (--tm-url), "
                                "skipping registration")
            else:
                api_key = step_get_admin_api_key(cfg, dry_run)
                result = step_register_rds_instance(
                    cfg, cluster_endpoint, api_key, dry_run)
                reg_id = result.get("id") if result else None
                success = step_verify_registration(
                    cfg, api_key, reg_id, dry_run)
                if not success and not dry_run:
                    sys.exit(1)

        logger.info("")
        logger.info("All steps completed successfully")
        logger.info(f"Cluster endpoint:  {cluster_endpoint}")
        logger.info(f"Reader endpoint:   {reader_endpoint}")
        logger.info(f"Secret ARN:        {secret_arn}")

    except Exception as e:
        logger.error(f"Execution failed: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()

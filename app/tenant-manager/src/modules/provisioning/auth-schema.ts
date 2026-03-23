/**
 * Consolidated auth schema DDL
 * Source: GoTrue /usr/local/etc/auth/migrations/ (65 migration files)
 *
 * This file contains the complete auth schema structure as of the latest GoTrue version.
 * All table definitions represent the final state after all migrations have been applied.
 */

export const AUTH_SCHEMA_DDL = `
-- ========================================================================
-- AUTH SCHEMA DDL - Consolidated from GoTrue migrations
-- ========================================================================
-- This DDL creates the complete auth schema structure for Supabase.
-- All {{ index .Options "Namespace" }} placeholders have been replaced with 'auth'.
-- The DDL is idempotent - safe to run multiple times.
-- ========================================================================

-- ========================================================================
-- ENUM TYPES
-- ========================================================================

-- Factor type for MFA
DO $$ BEGIN
    CREATE TYPE factor_type AS ENUM('totp', 'webauthn', 'phone');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- Factor status for MFA
DO $$ BEGIN
    CREATE TYPE factor_status AS ENUM('unverified', 'verified');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- Authentication Assurance Level
DO $$ BEGIN
    CREATE TYPE aal_level AS ENUM('aal1', 'aal2', 'aal3');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- Code challenge method for PKCE
DO $$ BEGIN
    CREATE TYPE code_challenge_method AS ENUM('s256', 'plain');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- One-time token types
DO $$ BEGIN
    CREATE TYPE one_time_token_type AS ENUM (
        'confirmation_token',
        'reauthentication_token',
        'recovery_token',
        'email_change_token_new',
        'email_change_token_current',
        'phone_change_token'
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- OAuth registration type
DO $$ BEGIN
    CREATE TYPE auth.oauth_registration_type AS ENUM('dynamic', 'manual');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- OAuth authorization status
DO $$ BEGIN
    CREATE TYPE auth.oauth_authorization_status AS ENUM('pending', 'approved', 'denied', 'expired');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- OAuth response type
DO $$ BEGIN
    CREATE TYPE auth.oauth_response_type AS ENUM('code');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- OAuth client type
DO $$ BEGIN
    CREATE TYPE auth.oauth_client_type AS ENUM('public', 'confidential');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- ========================================================================
-- TABLES
-- ========================================================================

-- auth.users - Core user table
CREATE TABLE IF NOT EXISTS auth.users (
    instance_id uuid NULL,
    id uuid NOT NULL UNIQUE,
    aud varchar(255) NULL,
    "role" varchar(255) NULL,
    email varchar(255) NULL,
    encrypted_password varchar(255) NULL,
    email_confirmed_at timestamptz NULL,
    invited_at timestamptz NULL,
    confirmation_token varchar(255) NULL,
    confirmation_sent_at timestamptz NULL,
    recovery_token varchar(255) NULL,
    recovery_sent_at timestamptz NULL,
    email_change_token_new varchar(255) NULL DEFAULT '',
    email_change varchar(255) NULL,
    email_change_sent_at timestamptz NULL,
    last_sign_in_at timestamptz NULL,
    raw_app_meta_data jsonb NULL,
    raw_user_meta_data jsonb NULL,
    is_super_admin bool NULL,
    created_at timestamptz NULL,
    updated_at timestamptz NULL,
    phone text NULL DEFAULT NULL,
    phone_confirmed_at timestamptz NULL DEFAULT NULL,
    phone_change text NULL DEFAULT '',
    phone_change_token varchar(255) NULL DEFAULT '',
    phone_change_sent_at timestamptz NULL DEFAULT NULL,
    confirmed_at timestamptz GENERATED ALWAYS AS (LEAST (users.email_confirmed_at, users.phone_confirmed_at)) STORED,
    email_change_token_current varchar(255) NULL DEFAULT '',
    email_change_confirm_status smallint DEFAULT 0 CHECK (email_change_confirm_status >= 0 AND email_change_confirm_status <= 2),
    banned_until timestamptz NULL,
    reauthentication_token varchar(255) NULL DEFAULT '',
    reauthentication_sent_at timestamptz NULL DEFAULT NULL,
    is_sso_user boolean NOT NULL DEFAULT false,
    deleted_at timestamptz NULL,
    is_anonymous boolean NOT NULL DEFAULT false,
    CONSTRAINT users_pkey PRIMARY KEY (id)
);

-- Users indexes
CREATE INDEX IF NOT EXISTS users_instance_id_idx ON auth.users USING btree (instance_id);
CREATE INDEX IF NOT EXISTS users_instance_id_email_idx ON auth.users USING btree (instance_id, LOWER(email));
CREATE UNIQUE INDEX IF NOT EXISTS users_email_partial_key ON auth.users (email) WHERE (is_sso_user = false);
CREATE UNIQUE INDEX IF NOT EXISTS confirmation_token_idx ON auth.users USING btree (confirmation_token) WHERE confirmation_token !~ '^[0-9 ]*$';
CREATE UNIQUE INDEX IF NOT EXISTS recovery_token_idx ON auth.users USING btree (recovery_token) WHERE recovery_token !~ '^[0-9 ]*$';
CREATE UNIQUE INDEX IF NOT EXISTS email_change_token_current_idx ON auth.users USING btree (email_change_token_current) WHERE email_change_token_current !~ '^[0-9 ]*$';
CREATE UNIQUE INDEX IF NOT EXISTS email_change_token_new_idx ON auth.users USING btree (email_change_token_new) WHERE email_change_token_new !~ '^[0-9 ]*$';
CREATE UNIQUE INDEX IF NOT EXISTS reauthentication_token_idx ON auth.users USING btree (reauthentication_token) WHERE reauthentication_token !~ '^[0-9 ]*$';
CREATE INDEX IF NOT EXISTS users_is_anonymous_idx ON auth.users USING btree (is_anonymous);

COMMENT ON TABLE auth.users IS 'Auth: Stores user login data within a secure schema.';
COMMENT ON COLUMN auth.users.is_sso_user IS 'Auth: Set this column to true when the account comes from SSO. These accounts can have duplicate emails.';

-- auth.refresh_tokens - JWT refresh tokens
CREATE TABLE IF NOT EXISTS auth.refresh_tokens (
    instance_id uuid NULL,
    id bigserial NOT NULL,
    "token" varchar(255) NULL,
    user_id varchar(255) NULL,
    revoked bool NULL,
    created_at timestamptz NULL,
    updated_at timestamptz NULL,
    parent varchar(255) NULL,
    session_id uuid NULL,
    CONSTRAINT refresh_tokens_pkey PRIMARY KEY (id),
    CONSTRAINT refresh_tokens_token_unique UNIQUE ("token")
);

CREATE INDEX IF NOT EXISTS refresh_tokens_instance_id_idx ON auth.refresh_tokens USING btree (instance_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_instance_id_user_id_idx ON auth.refresh_tokens USING btree (instance_id, user_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_parent_idx ON auth.refresh_tokens USING btree (parent);
CREATE INDEX IF NOT EXISTS refresh_tokens_session_id_revoked_idx ON auth.refresh_tokens (session_id, revoked);
CREATE INDEX IF NOT EXISTS refresh_tokens_updated_at_idx ON auth.refresh_tokens (updated_at DESC);

COMMENT ON TABLE auth.refresh_tokens IS 'Auth: Store of tokens used to refresh JWT tokens once they expire.';

-- auth.instances - Multi-instance support
CREATE TABLE IF NOT EXISTS auth.instances (
    id uuid NOT NULL,
    uuid uuid NULL,
    raw_base_config text NULL,
    created_at timestamptz NULL,
    updated_at timestamptz NULL,
    CONSTRAINT instances_pkey PRIMARY KEY (id)
);

COMMENT ON TABLE auth.instances IS 'Auth: Manages users across multiple sites.';

-- auth.audit_log_entries - Audit trail
CREATE TABLE IF NOT EXISTS auth.audit_log_entries (
    instance_id uuid NULL,
    id uuid NOT NULL,
    payload json NULL,
    created_at timestamptz NULL,
    ip_address varchar(64) NOT NULL DEFAULT '',
    CONSTRAINT audit_log_entries_pkey PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS audit_logs_instance_id_idx ON auth.audit_log_entries USING btree (instance_id);

COMMENT ON TABLE auth.audit_log_entries IS 'Auth: Audit trail for user actions.';

-- auth.schema_migrations - Migration tracking
CREATE TABLE IF NOT EXISTS auth.schema_migrations (
    "version" varchar(255) NOT NULL,
    CONSTRAINT schema_migrations_pkey PRIMARY KEY ("version")
);

COMMENT ON TABLE auth.schema_migrations IS 'Auth: Manages updates to the auth system.';

-- auth.identities - User identities (social login, etc.)
CREATE TABLE IF NOT EXISTS auth.identities (
    provider_id text NOT NULL,
    user_id uuid NOT NULL,
    identity_data jsonb NOT NULL,
    provider text NOT NULL,
    last_sign_in_at timestamptz NULL,
    created_at timestamptz NULL,
    updated_at timestamptz NULL,
    email text GENERATED ALWAYS AS (LOWER(identity_data->>'email')) STORED,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    CONSTRAINT identities_pkey PRIMARY KEY (id),
    CONSTRAINT identities_provider_id_provider_unique UNIQUE (provider_id, provider),
    CONSTRAINT identities_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS identities_user_id_idx ON auth.identities USING btree (user_id);
CREATE INDEX IF NOT EXISTS identities_email_idx ON auth.identities (email text_pattern_ops);

COMMENT ON TABLE auth.identities IS 'Auth: Stores identities associated to a user.';
COMMENT ON COLUMN auth.identities.email IS 'Auth: Email is a generated column that references the optional email property in the identity_data';

-- auth.sessions - User sessions
CREATE TABLE IF NOT EXISTS auth.sessions (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    created_at timestamptz NULL,
    updated_at timestamptz NULL,
    factor_id uuid NULL,
    aal aal_level NULL,
    not_after timestamptz NULL,
    refreshed_at timestamp without time zone,
    user_agent text,
    ip inet,
    tag text,
    oauth_client_id uuid,
    refresh_token_hmac_key text,
    refresh_token_counter bigint,
    scopes text,
    CONSTRAINT sessions_pkey PRIMARY KEY (id),
    CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
    CONSTRAINT sessions_scopes_length CHECK (char_length(scopes) <= 4096)
);

CREATE INDEX IF NOT EXISTS user_id_created_at_idx ON auth.sessions (user_id, created_at);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON auth.sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_not_after_idx ON auth.sessions (not_after DESC);
CREATE INDEX IF NOT EXISTS sessions_oauth_client_id_idx ON auth.sessions (oauth_client_id);

COMMENT ON TABLE auth.sessions IS 'Auth: Stores session data associated to a user.';
COMMENT ON COLUMN auth.sessions.not_after IS 'Auth: Not after is a nullable column that contains a timestamp after which the session should be regarded as expired.';
COMMENT ON COLUMN auth.sessions.refresh_token_hmac_key IS 'Holds a HMAC-SHA256 key used to sign refresh tokens for this session.';
COMMENT ON COLUMN auth.sessions.refresh_token_counter IS 'Holds the ID (counter) of the last issued refresh token.';

-- Add foreign key for refresh_tokens.session_id after sessions table is created
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'refresh_tokens_session_id_fkey'
        AND table_schema = 'auth'
    ) THEN
        ALTER TABLE auth.refresh_tokens
        ADD CONSTRAINT refresh_tokens_session_id_fkey
        FOREIGN KEY (session_id) REFERENCES auth.sessions(id) ON DELETE CASCADE;
    END IF;
END $$;

-- auth.mfa_factors - MFA factor storage
CREATE TABLE IF NOT EXISTS auth.mfa_factors (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    friendly_name text NULL,
    factor_type factor_type NOT NULL,
    status factor_status NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    secret text NULL,
    phone text DEFAULT NULL,
    last_challenged_at timestamptz DEFAULT NULL,
    web_authn_credential jsonb NULL,
    web_authn_aaguid uuid NULL,
    last_webauthn_challenge_data jsonb NULL,
    CONSTRAINT mfa_factors_pkey PRIMARY KEY (id),
    CONSTRAINT mfa_factors_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS mfa_factors_user_friendly_name_unique ON auth.mfa_factors (friendly_name, user_id) WHERE TRIM(friendly_name) <> '';
CREATE INDEX IF NOT EXISTS factor_id_created_at_idx ON auth.mfa_factors (user_id, created_at);
CREATE INDEX IF NOT EXISTS mfa_factors_user_id_idx ON auth.mfa_factors (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS unique_phone_factor_per_user ON auth.mfa_factors (user_id, phone);

COMMENT ON TABLE auth.mfa_factors IS 'auth: stores metadata about factors';
COMMENT ON COLUMN auth.mfa_factors.last_webauthn_challenge_data IS 'Stores the latest WebAuthn challenge data including attestation/assertion for customer verification';

-- auth.mfa_challenges - MFA challenge storage
CREATE TABLE IF NOT EXISTS auth.mfa_challenges (
    id uuid NOT NULL,
    factor_id uuid NOT NULL,
    created_at timestamptz NOT NULL,
    verified_at timestamptz NULL,
    ip_address inet NOT NULL,
    otp_code text NULL,
    web_authn_session_data jsonb NULL,
    CONSTRAINT mfa_challenges_pkey PRIMARY KEY (id),
    CONSTRAINT mfa_challenges_auth_factor_id_fkey FOREIGN KEY (factor_id) REFERENCES auth.mfa_factors(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS mfa_challenge_created_at_idx ON auth.mfa_challenges (created_at DESC);

COMMENT ON TABLE auth.mfa_challenges IS 'auth: stores metadata about challenge requests made';

-- auth.mfa_amr_claims - Authentication Method Reference claims
CREATE TABLE IF NOT EXISTS auth.mfa_amr_claims (
    session_id uuid NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    authentication_method text NOT NULL,
    id uuid NOT NULL,
    CONSTRAINT mfa_amr_claims_session_id_authentication_method_pkey UNIQUE (session_id, authentication_method),
    CONSTRAINT amr_id_pk PRIMARY KEY (id),
    CONSTRAINT mfa_amr_claims_session_id_fkey FOREIGN KEY (session_id) REFERENCES auth.sessions(id) ON DELETE CASCADE
);

COMMENT ON TABLE auth.mfa_amr_claims IS 'auth: stores authenticator method reference claims for multi factor authentication';

-- auth.sso_providers - SSO identity providers
CREATE TABLE IF NOT EXISTS auth.sso_providers (
    id uuid NOT NULL,
    resource_id text NULL,
    created_at timestamptz NULL,
    updated_at timestamptz NULL,
    disabled boolean NULL,
    PRIMARY KEY (id),
    CONSTRAINT "resource_id not empty" CHECK (resource_id = NULL OR char_length(resource_id) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS sso_providers_resource_id_idx ON auth.sso_providers (LOWER(resource_id));
CREATE INDEX IF NOT EXISTS sso_providers_resource_id_pattern_idx ON auth.sso_providers (resource_id text_pattern_ops);

COMMENT ON TABLE auth.sso_providers IS 'Auth: Manages SSO identity provider information; see saml_providers for SAML.';
COMMENT ON COLUMN auth.sso_providers.resource_id IS 'Auth: Uniquely identifies a SSO provider according to a user-chosen resource ID (case insensitive), useful in infrastructure as code.';

-- auth.sso_domains - SSO domain mapping
CREATE TABLE IF NOT EXISTS auth.sso_domains (
    id uuid NOT NULL,
    sso_provider_id uuid NOT NULL,
    domain text NOT NULL,
    created_at timestamptz NULL,
    updated_at timestamptz NULL,
    PRIMARY KEY (id),
    FOREIGN KEY (sso_provider_id) REFERENCES auth.sso_providers(id) ON DELETE CASCADE,
    CONSTRAINT "domain not empty" CHECK (char_length(domain) > 0)
);

CREATE INDEX IF NOT EXISTS sso_domains_sso_provider_id_idx ON auth.sso_domains (sso_provider_id);
CREATE UNIQUE INDEX IF NOT EXISTS sso_domains_domain_idx ON auth.sso_domains (LOWER(domain));

COMMENT ON TABLE auth.sso_domains IS 'Auth: Manages SSO email address domain mapping to an SSO Identity Provider.';

-- auth.saml_providers - SAML identity providers
CREATE TABLE IF NOT EXISTS auth.saml_providers (
    id uuid NOT NULL,
    sso_provider_id uuid NOT NULL,
    entity_id text NOT NULL UNIQUE,
    metadata_xml text NOT NULL,
    metadata_url text NULL,
    attribute_mapping jsonb NULL,
    created_at timestamptz NULL,
    updated_at timestamptz NULL,
    name_id_format text NULL,
    PRIMARY KEY (id),
    FOREIGN KEY (sso_provider_id) REFERENCES auth.sso_providers(id) ON DELETE CASCADE,
    CONSTRAINT "metadata_xml not empty" CHECK (char_length(metadata_xml) > 0),
    CONSTRAINT "metadata_url not empty" CHECK (metadata_url = NULL OR char_length(metadata_url) > 0),
    CONSTRAINT "entity_id not empty" CHECK (char_length(entity_id) > 0)
);

CREATE INDEX IF NOT EXISTS saml_providers_sso_provider_id_idx ON auth.saml_providers (sso_provider_id);

COMMENT ON TABLE auth.saml_providers IS 'Auth: Manages SAML Identity Provider connections.';

-- auth.saml_relay_states - SAML relay state storage
CREATE TABLE IF NOT EXISTS auth.saml_relay_states (
    id uuid NOT NULL,
    sso_provider_id uuid NOT NULL,
    request_id text NOT NULL,
    for_email text NULL,
    redirect_to text NULL,
    created_at timestamptz NULL,
    updated_at timestamptz NULL,
    flow_state_id uuid NULL,
    PRIMARY KEY (id),
    FOREIGN KEY (sso_provider_id) REFERENCES auth.sso_providers(id) ON DELETE CASCADE,
    CONSTRAINT "request_id not empty" CHECK (char_length(request_id) > 0)
);

CREATE INDEX IF NOT EXISTS saml_relay_states_sso_provider_id_idx ON auth.saml_relay_states (sso_provider_id);
CREATE INDEX IF NOT EXISTS saml_relay_states_for_email_idx ON auth.saml_relay_states (for_email);
CREATE INDEX IF NOT EXISTS saml_relay_states_created_at_idx ON auth.saml_relay_states (created_at DESC);

COMMENT ON TABLE auth.saml_relay_states IS 'Auth: Contains SAML Relay State information for each Service Provider initiated login.';

-- auth.flow_state - PKCE flow state storage
CREATE TABLE IF NOT EXISTS auth.flow_state (
    id uuid PRIMARY KEY,
    user_id uuid NULL,
    auth_code text NOT NULL,
    code_challenge_method code_challenge_method NOT NULL,
    code_challenge text NOT NULL,
    provider_type text NOT NULL,
    provider_access_token text NULL,
    provider_refresh_token text NULL,
    created_at timestamptz NULL,
    updated_at timestamptz NULL,
    authentication_method text NOT NULL,
    auth_code_issued_at timestamptz NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_code ON auth.flow_state (auth_code);
CREATE INDEX IF NOT EXISTS idx_user_id_auth_method ON auth.flow_state (user_id, authentication_method);
CREATE INDEX IF NOT EXISTS flow_state_created_at_idx ON auth.flow_state (created_at DESC);

COMMENT ON TABLE auth.flow_state IS 'stores metadata for pkce logins';

-- Add foreign key for saml_relay_states.flow_state_id after flow_state table is created
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'saml_relay_states_flow_state_id_fkey'
        AND table_schema = 'auth'
    ) THEN
        ALTER TABLE auth.saml_relay_states
        ADD CONSTRAINT saml_relay_states_flow_state_id_fkey
        FOREIGN KEY (flow_state_id) REFERENCES auth.flow_state(id) ON DELETE CASCADE;
    END IF;
END $$;

-- auth.one_time_tokens - One-time tokens for various auth flows
CREATE TABLE IF NOT EXISTS auth.one_time_tokens (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES auth.users ON DELETE CASCADE,
    token_type one_time_token_type NOT NULL,
    token_hash text NOT NULL,
    relates_to text NOT NULL,
    created_at timestamp without time zone NOT NULL DEFAULT now(),
    updated_at timestamp without time zone NOT NULL DEFAULT now(),
    CHECK (char_length(token_hash) > 0)
);

CREATE INDEX IF NOT EXISTS one_time_tokens_token_hash_hash_idx ON auth.one_time_tokens USING hash (token_hash);
CREATE INDEX IF NOT EXISTS one_time_tokens_relates_to_hash_idx ON auth.one_time_tokens USING hash (relates_to);
CREATE UNIQUE INDEX IF NOT EXISTS one_time_tokens_user_id_token_type_key ON auth.one_time_tokens (user_id, token_type);

-- auth.oauth_clients - OAuth 2.1 client management
CREATE TABLE IF NOT EXISTS auth.oauth_clients (
    id uuid NOT NULL,
    client_secret_hash text NULL,
    registration_type auth.oauth_registration_type NOT NULL,
    redirect_uris text NOT NULL,
    grant_types text NOT NULL,
    client_name text NULL,
    client_uri text NULL,
    logo_uri text NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz NULL,
    client_type auth.oauth_client_type NOT NULL DEFAULT 'confidential',
    CONSTRAINT oauth_clients_pkey PRIMARY KEY (id),
    CONSTRAINT oauth_clients_client_name_length CHECK (char_length(client_name) <= 1024),
    CONSTRAINT oauth_clients_client_uri_length CHECK (char_length(client_uri) <= 2048),
    CONSTRAINT oauth_clients_logo_uri_length CHECK (char_length(logo_uri) <= 2048)
);

CREATE INDEX IF NOT EXISTS oauth_clients_deleted_at_idx ON auth.oauth_clients (deleted_at);

-- Add foreign key for sessions.oauth_client_id after oauth_clients table is created
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'sessions_oauth_client_id_fkey'
        AND table_schema = 'auth'
    ) THEN
        ALTER TABLE auth.sessions
        ADD CONSTRAINT sessions_oauth_client_id_fkey
        FOREIGN KEY (oauth_client_id) REFERENCES auth.oauth_clients(id) ON DELETE CASCADE;
    END IF;
END $$;

-- auth.oauth_authorizations - OAuth 2.1 authorization requests
CREATE TABLE IF NOT EXISTS auth.oauth_authorizations (
    id uuid NOT NULL,
    authorization_id text NOT NULL,
    client_id uuid NOT NULL REFERENCES auth.oauth_clients(id) ON DELETE CASCADE,
    user_id uuid NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    redirect_uri text NOT NULL,
    scope text NOT NULL,
    state text NULL,
    resource text NULL,
    code_challenge text NULL,
    code_challenge_method code_challenge_method NULL,
    response_type auth.oauth_response_type NOT NULL DEFAULT 'code',
    status auth.oauth_authorization_status NOT NULL DEFAULT 'pending',
    authorization_code text NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL DEFAULT (now() + interval '3 minutes'),
    approved_at timestamptz NULL,
    nonce text NULL,
    CONSTRAINT oauth_authorizations_pkey PRIMARY KEY (id),
    CONSTRAINT oauth_authorizations_authorization_id_key UNIQUE (authorization_id),
    CONSTRAINT oauth_authorizations_authorization_code_key UNIQUE (authorization_code),
    CONSTRAINT oauth_authorizations_redirect_uri_length CHECK (char_length(redirect_uri) <= 2048),
    CONSTRAINT oauth_authorizations_scope_length CHECK (char_length(scope) <= 4096),
    CONSTRAINT oauth_authorizations_state_length CHECK (char_length(state) <= 4096),
    CONSTRAINT oauth_authorizations_resource_length CHECK (char_length(resource) <= 2048),
    CONSTRAINT oauth_authorizations_code_challenge_length CHECK (char_length(code_challenge) <= 128),
    CONSTRAINT oauth_authorizations_authorization_code_length CHECK (char_length(authorization_code) <= 255),
    CONSTRAINT oauth_authorizations_expires_at_future CHECK (expires_at > created_at),
    CONSTRAINT oauth_authorizations_nonce_length CHECK (char_length(nonce) <= 255)
);

CREATE INDEX IF NOT EXISTS oauth_auth_pending_exp_idx ON auth.oauth_authorizations (expires_at) WHERE status = 'pending';

-- auth.oauth_consents - User consent management
CREATE TABLE IF NOT EXISTS auth.oauth_consents (
    id uuid NOT NULL,
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    client_id uuid NOT NULL REFERENCES auth.oauth_clients(id) ON DELETE CASCADE,
    scopes text NOT NULL,
    granted_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz NULL,
    CONSTRAINT oauth_consents_pkey PRIMARY KEY (id),
    CONSTRAINT oauth_consents_user_client_unique UNIQUE (user_id, client_id),
    CONSTRAINT oauth_consents_scopes_length CHECK (char_length(scopes) <= 2048),
    CONSTRAINT oauth_consents_scopes_not_empty CHECK (char_length(trim(scopes)) > 0),
    CONSTRAINT oauth_consents_revoked_after_granted CHECK (revoked_at IS NULL OR revoked_at >= granted_at)
);

CREATE INDEX IF NOT EXISTS oauth_consents_active_user_client_idx ON auth.oauth_consents (user_id, client_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS oauth_consents_user_order_idx ON auth.oauth_consents (user_id, granted_at DESC);
CREATE INDEX IF NOT EXISTS oauth_consents_active_client_idx ON auth.oauth_consents (client_id) WHERE revoked_at IS NULL;

-- auth.oauth_client_states - OAuth client state storage
CREATE TABLE IF NOT EXISTS auth.oauth_client_states (
    id uuid PRIMARY KEY,
    provider_type text NOT NULL,
    code_verifier text,
    created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_client_states_created_at ON auth.oauth_client_states (created_at);

COMMENT ON TABLE auth.oauth_client_states IS 'Stores OAuth states for third-party provider authentication flows where Supabase acts as the OAuth client.';

-- ========================================================================
-- FUNCTIONS
-- ========================================================================

-- auth.uid() - Get current user ID from JWT
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql STABLE
AS $$
    SELECT
    COALESCE(
        NULLIF(current_setting('request.jwt.claim.sub', true), ''),
        (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    )::uuid
$$;

COMMENT ON FUNCTION auth.uid() IS 'Deprecated. Use auth.jwt() -> ''sub'' instead.';

-- auth.role() - Get current user role from JWT
CREATE OR REPLACE FUNCTION auth.role()
RETURNS text
LANGUAGE sql STABLE
AS $$
    SELECT
    COALESCE(
        NULLIF(current_setting('request.jwt.claim.role', true), ''),
        (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
    )::text
$$;

COMMENT ON FUNCTION auth.role() IS 'Deprecated. Use auth.jwt() -> ''role'' instead.';

-- auth.email() - Get current user email from JWT
CREATE OR REPLACE FUNCTION auth.email()
RETURNS text
LANGUAGE sql STABLE
AS $$
    SELECT
    COALESCE(
        NULLIF(current_setting('request.jwt.claim.email', true), ''),
        (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
    )::text
$$;

COMMENT ON FUNCTION auth.email() IS 'Deprecated. Use auth.jwt() -> ''email'' instead.';

-- auth.jwt() - Get full JWT claims
CREATE OR REPLACE FUNCTION auth.jwt()
RETURNS jsonb
LANGUAGE sql STABLE
AS $$
    SELECT
        COALESCE(
            NULLIF(current_setting('request.jwt.claim', true), ''),
            NULLIF(current_setting('request.jwt.claims', true), '')
        )::jsonb
$$;

-- ========================================================================
-- ROW LEVEL SECURITY
-- ========================================================================

-- Enable RLS on all auth tables
ALTER TABLE auth.schema_migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.audit_log_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.saml_relay_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.mfa_factors ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.sso_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.sso_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.mfa_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.mfa_amr_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.saml_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.flow_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.one_time_tokens ENABLE ROW LEVEL SECURITY;

-- ========================================================================
-- GRANTS
-- ========================================================================

-- Grant postgres role SELECT with grant option on auth tables
GRANT SELECT ON auth.schema_migrations TO postgres WITH GRANT OPTION;
GRANT SELECT ON auth.instances TO postgres WITH GRANT OPTION;
GRANT SELECT ON auth.users TO postgres WITH GRANT OPTION;
GRANT SELECT ON auth.audit_log_entries TO postgres WITH GRANT OPTION;
GRANT SELECT ON auth.saml_relay_states TO postgres WITH GRANT OPTION;
GRANT SELECT ON auth.refresh_tokens TO postgres WITH GRANT OPTION;
GRANT SELECT ON auth.mfa_factors TO postgres WITH GRANT OPTION;
GRANT SELECT ON auth.sessions TO postgres WITH GRANT OPTION;
GRANT SELECT ON auth.sso_providers TO postgres WITH GRANT OPTION;
GRANT SELECT ON auth.sso_domains TO postgres WITH GRANT OPTION;
GRANT SELECT ON auth.mfa_challenges TO postgres WITH GRANT OPTION;
GRANT SELECT ON auth.mfa_amr_claims TO postgres WITH GRANT OPTION;
GRANT SELECT ON auth.saml_providers TO postgres WITH GRANT OPTION;
GRANT SELECT ON auth.flow_state TO postgres WITH GRANT OPTION;
GRANT SELECT ON auth.identities TO postgres WITH GRANT OPTION;
GRANT SELECT ON auth.one_time_tokens TO postgres WITH GRANT OPTION;

-- Grant execute on auth functions
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.role() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.email() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.jwt() TO anon, authenticated, service_role;
`

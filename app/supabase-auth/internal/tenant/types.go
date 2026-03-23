package tenant

import (
	"github.com/supabase/auth/internal/conf"
	"github.com/supabase/auth/internal/storage"
)

// TenantConfig holds the configuration for a tenant retrieved from tenant-manager API
type TenantConfig struct {
	TenantID    string
	DatabaseURL string
	JWTSecret   string
	JWTConfig   *conf.JWTConfiguration // pre-built JWT config with Keys for signing/verification
	SiteURL     string
}

// TenantContext holds the tenant-specific context for a request
type TenantContext struct {
	TenantID   string
	Connection *storage.Connection
	Config     *TenantConfig
}

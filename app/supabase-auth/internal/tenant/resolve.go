package tenant

import (
	"context"

	"github.com/supabase/auth/internal/conf"
)

// ResolveExternalConfig returns the external (social/OAuth) provider
// configuration that applies to the current request.
//
// In multi-tenant mode each tenant may carry its own provider credentials
// (delivered by tenant-manager and stored on TenantConfig.External). When a
// tenant context with external config is present, the per-tenant providers are
// overlaid on top of the global configuration so that globally-configured
// values (e.g. AllowedIdTokenIssuers, IosBundleId, RedirectURL) are preserved
// while the tenant's own provider credentials take effect. When there is no
// tenant context (single-tenant mode) the global configuration is returned
// unchanged.
func ResolveExternalConfig(ctx context.Context, global conf.ProviderConfiguration) conf.ProviderConfiguration {
	tc, ok := GetTenantFromContext(ctx)
	if !ok || tc.Config == nil || tc.Config.External == nil {
		return global
	}

	resolved := global
	resolved.Google = tc.Config.External.Google
	return resolved
}

package tenant

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/auth/internal/conf"
)

func globalProviderConfig() conf.ProviderConfiguration {
	return conf.ProviderConfiguration{
		Google: conf.OAuthProviderConfiguration{
			ClientID:    []string{"global-client"},
			Secret:      "global-secret",
			RedirectURI: "https://global.example.com/callback",
			Enabled:     true,
		},
		IosBundleId:           "com.example.app",
		AllowedIdTokenIssuers: []string{"https://accounts.google.com"},
	}
}

// No tenant context => global config returned unchanged.
func TestResolveExternalConfig_NoTenantContext(t *testing.T) {
	global := globalProviderConfig()

	resolved := ResolveExternalConfig(context.Background(), global)

	assert.Equal(t, global, resolved)
}

// Tenant context present but no External config => fall back to global.
func TestResolveExternalConfig_TenantWithoutExternal(t *testing.T) {
	global := globalProviderConfig()

	ctx := SetTenantInContext(context.Background(), &TenantContext{
		TenantID: "tenant-a",
		Config:   &TenantConfig{TenantID: "tenant-a"},
	})

	resolved := ResolveExternalConfig(ctx, global)

	assert.Equal(t, global, resolved)
}

// Tenant context with nil Config => fall back to global.
func TestResolveExternalConfig_NilTenantConfig(t *testing.T) {
	global := globalProviderConfig()

	ctx := SetTenantInContext(context.Background(), &TenantContext{TenantID: "tenant-a"})

	resolved := ResolveExternalConfig(ctx, global)

	assert.Equal(t, global, resolved)
}

// Tenant external Google overrides global, while non-Google global fields are preserved.
func TestResolveExternalConfig_TenantOverridesGoogle(t *testing.T) {
	global := globalProviderConfig()

	tenantGoogle := conf.OAuthProviderConfiguration{
		ClientID:       []string{"tenant-client"},
		Secret:         "tenant-secret",
		RedirectURI:    "https://tenant-a.example.com/auth/v1/callback",
		Enabled:        true,
		SkipNonceCheck: true,
	}
	ctx := SetTenantInContext(context.Background(), &TenantContext{
		TenantID: "tenant-a",
		Config: &TenantConfig{
			TenantID: "tenant-a",
			External: &conf.ProviderConfiguration{Google: tenantGoogle},
		},
	})

	resolved := ResolveExternalConfig(ctx, global)

	// Google fields come from the tenant.
	assert.Equal(t, tenantGoogle, resolved.Google)
	assert.Equal(t, []string{"tenant-client"}, resolved.Google.ClientID)
	assert.True(t, resolved.Google.SkipNonceCheck)
	// Non-Google global fields are preserved (overlay semantics).
	assert.Equal(t, "com.example.app", resolved.IosBundleId)
	assert.Equal(t, []string{"https://accounts.google.com"}, resolved.AllowedIdTokenIssuers)
}

// Resolving must not mutate the caller's global config.
func TestResolveExternalConfig_DoesNotMutateGlobal(t *testing.T) {
	global := globalProviderConfig()

	ctx := SetTenantInContext(context.Background(), &TenantContext{
		TenantID: "tenant-a",
		Config: &TenantConfig{
			TenantID: "tenant-a",
			External: &conf.ProviderConfiguration{
				Google: conf.OAuthProviderConfiguration{
					ClientID: []string{"tenant-client"},
					Secret:   "tenant-secret",
					Enabled:  true,
				},
			},
		},
	})

	resolved := ResolveExternalConfig(ctx, global)

	// The global config still carries its original Google credentials.
	require.Equal(t, []string{"global-client"}, global.Google.ClientID)
	assert.Equal(t, "global-secret", global.Google.Secret)
	// And the resolved copy is independent.
	assert.NotEqual(t, global.Google.ClientID, resolved.Google.ClientID)
}

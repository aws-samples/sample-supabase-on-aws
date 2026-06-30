package tenant

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/auth/internal/conf"
)

// mockTenantManager spins up an httptest server emulating the tenant-manager
// admin API endpoints that Manager.fetchTenantConfig calls.
//
// projectBody is the JSON object returned (inside {"data": ...}) for
// GET /admin/v1/projects/:ref. dbHits/projectHits count requests so tests can
// assert caching behaviour.
func mockTenantManager(t *testing.T, projectBody string) (*httptest.Server, *int, *int) {
	t.Helper()
	projectHits := 0
	dbHits := 0

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasSuffix(r.URL.Path, "/database-credentials"):
			dbHits++
			_, _ = w.Write([]byte(`{"data":{"project_ref":"tenant-a","db_name":"postgres","host":"db.local","port":5432,"user":"u","password":"p"}}`))
		default:
			projectHits++
			_, _ = w.Write([]byte(projectBody))
		}
	}))
	t.Cleanup(srv.Close)
	return srv, &projectHits, &dbHits
}

func newTestManager(url string) *Manager {
	cfg := &conf.MultiTenantConfiguration{
		TenantManagerURL: url,
		TenantManagerKey: "test-key",
		CacheTTL:         5 * time.Minute,
	}
	// baseJWTConfig is nil and the mock returns an empty jwt_secret, so the
	// JWT-building branch in fetchTenantConfig is skipped.
	return NewManager(cfg, nil)
}

// External google config is decoded into TenantConfig.External.
func TestFetchTenantConfig_DecodesGoogleExternal(t *testing.T) {
	body := `{"data":{"ref":"tenant-a","jwt_secret":"","external":{"google":{"enabled":true,"client_id":["tenant-client"],"secret":"tenant-secret","redirect_uri":"https://tenant-a.example.com/auth/v1/callback","skip_nonce_check":true}}}}`
	srv, _, _ := mockTenantManager(t, body)
	m := newTestManager(srv.URL)

	cfg, err := m.GetTenantConfig(context.Background(), "tenant-a")
	require.NoError(t, err)
	require.NotNil(t, cfg.External, "External should be populated")

	g := cfg.External.Google
	assert.True(t, g.Enabled)
	assert.Equal(t, []string{"tenant-client"}, g.ClientID)
	assert.Equal(t, "tenant-secret", g.Secret)
	assert.Equal(t, "https://tenant-a.example.com/auth/v1/callback", g.RedirectURI)
	assert.True(t, g.SkipNonceCheck)

	// Database URL is composed from the credentials endpoint.
	assert.Contains(t, cfg.DatabaseURL, "db.local")
	assert.Contains(t, cfg.DatabaseURL, "postgres")
}

// When the response carries no external block, TenantConfig.External is nil.
func TestFetchTenantConfig_NoExternal(t *testing.T) {
	body := `{"data":{"ref":"tenant-a","jwt_secret":""}}`
	srv, _, _ := mockTenantManager(t, body)
	m := newTestManager(srv.URL)

	cfg, err := m.GetTenantConfig(context.Background(), "tenant-a")
	require.NoError(t, err)
	assert.Nil(t, cfg.External, "External should be nil when not provided")
}

// Second lookup within the TTL is served from cache (no extra upstream hits).
func TestGetTenantConfig_UsesCache(t *testing.T) {
	body := `{"data":{"ref":"tenant-a","jwt_secret":"","external":{"google":{"enabled":true,"client_id":["c"],"secret":"s"}}}}`
	srv, projectHits, dbHits := mockTenantManager(t, body)
	m := newTestManager(srv.URL)

	_, err := m.GetTenantConfig(context.Background(), "tenant-a")
	require.NoError(t, err)
	_, err = m.GetTenantConfig(context.Background(), "tenant-a")
	require.NoError(t, err)

	assert.Equal(t, 1, *projectHits, "project endpoint should be hit once")
	assert.Equal(t, 1, *dbHits, "db-credentials endpoint should be hit once")
}

// After InvalidateCache, the next lookup re-fetches from upstream.
func TestInvalidateCache_ForcesRefetch(t *testing.T) {
	body := `{"data":{"ref":"tenant-a","jwt_secret":"","external":{"google":{"enabled":true,"client_id":["c"],"secret":"s"}}}}`
	srv, projectHits, _ := mockTenantManager(t, body)
	m := newTestManager(srv.URL)

	_, err := m.GetTenantConfig(context.Background(), "tenant-a")
	require.NoError(t, err)

	m.InvalidateCache("tenant-a")

	_, err = m.GetTenantConfig(context.Background(), "tenant-a")
	require.NoError(t, err)

	assert.Equal(t, 2, *projectHits, "invalidation should force a re-fetch")
}

// A 404 from the project endpoint is surfaced as an error.
func TestFetchTenantConfig_NotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	t.Cleanup(srv.Close)
	m := newTestManager(srv.URL)

	_, err := m.GetTenantConfig(context.Background(), "missing")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "tenant not found")
}

// Sanity: the JSON contract used here matches conf.OAuthProviderConfiguration tags.
func TestExternalJSONContractMatchesConf(t *testing.T) {
	raw := `{"google":{"enabled":true,"client_id":["a","b"],"secret":"x","redirect_uri":"https://r","skip_nonce_check":true,"email_optional":true}}`
	var pc conf.ProviderConfiguration
	require.NoError(t, json.Unmarshal([]byte(raw), &pc))

	assert.True(t, pc.Google.Enabled)
	assert.Equal(t, []string{"a", "b"}, pc.Google.ClientID)
	assert.Equal(t, "x", pc.Google.Secret)
	assert.Equal(t, "https://r", pc.Google.RedirectURI)
	assert.True(t, pc.Google.SkipNonceCheck)
	assert.True(t, pc.Google.EmailOptional)
}

package tenant

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/sirupsen/logrus"
	"github.com/supabase/auth/internal/conf"
)

// dbCredentialsResponse represents the response from the database-credentials API
type dbCredentialsResponse struct {
	Data dbCredentials `json:"data"`
}

type dbCredentials struct {
	ProjectRef string `json:"project_ref"`
	DBName     string `json:"db_name"`
	Host       string `json:"host"`
	Port       int    `json:"port"`
	User       string `json:"user"`
	Password   string `json:"password"`
}

// tenantManagerResponse represents the response from tenant-manager API
type tenantManagerResponse struct {
	Data tenantData `json:"data"`
}

type tenantData struct {
	Ref            string `json:"ref"`
	JWTSecret      string `json:"jwt_secret"`
	ServiceRoleKey string `json:"service_role_key"`
}

// cacheEntry holds a cached tenant config with expiration
type cacheEntry struct {
	config    *TenantConfig
	expiresAt time.Time
}

// Manager handles tenant configuration retrieval and caching
type Manager struct {
	config       *conf.MultiTenantConfiguration
	baseJWTConfig *conf.JWTConfiguration // global JWT config used as base for tenant configs
	httpClient   *http.Client
	cache        map[string]*cacheEntry
	cacheMu      sync.RWMutex
}

// NewManager creates a new tenant manager.
func NewManager(config *conf.MultiTenantConfiguration, baseJWTConfig *conf.JWTConfiguration) *Manager {
	return &Manager{
		config:       config,
		baseJWTConfig: baseJWTConfig,
		httpClient: &http.Client{
			Timeout: 10 * time.Second,
		},
		cache: make(map[string]*cacheEntry),
	}
}

// GetTenantConfig retrieves tenant configuration, using cache if available
func (m *Manager) GetTenantConfig(ctx context.Context, tenantID string) (*TenantConfig, error) {
	// Check cache first
	m.cacheMu.RLock()
	if entry, ok := m.cache[tenantID]; ok && time.Now().Before(entry.expiresAt) {
		m.cacheMu.RUnlock()
		return entry.config, nil
	}
	m.cacheMu.RUnlock()

	// Fetch from tenant-manager API
	config, err := m.fetchTenantConfig(ctx, tenantID)
	if err != nil {
		return nil, err
	}

	// Cache the result
	m.cacheMu.Lock()
	m.cache[tenantID] = &cacheEntry{
		config:    config,
		expiresAt: time.Now().Add(m.config.CacheTTL),
	}
	m.cacheMu.Unlock()

	return config, nil
}

// fetchTenantConfig fetches tenant configuration from tenant-manager API
func (m *Manager) fetchTenantConfig(ctx context.Context, tenantID string) (*TenantConfig, error) {
	reqURL := fmt.Sprintf("%s/admin/v1/projects/%s", m.config.TenantManagerURL, tenantID)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+m.config.TenantManagerKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := m.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch tenant config: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return nil, fmt.Errorf("tenant not found: %s", tenantID)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("tenant-manager returned status %d", resp.StatusCode)
	}

	var tmResp tenantManagerResponse
	if err := json.NewDecoder(resp.Body).Decode(&tmResp); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	// Fetch database credentials from dedicated API
	creds, err := m.fetchDBCredentials(ctx, tenantID)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch database credentials for tenant %s: %w", tenantID, err)
	}

	dbPort := creds.Port
	if dbPort == 0 {
		dbPort = 5432
	}

	databaseURL := fmt.Sprintf("postgres://%s:%s@%s:%d/%s?sslmode=verify-ca&sslrootcert=/etc/ssl/certs/rds-global-bundle.pem",
		creds.User,
		url.QueryEscape(creds.Password),
		creds.Host,
		dbPort,
		creds.DBName,
	)

	tenantConfig := &TenantConfig{
		TenantID:    tenantID,
		DatabaseURL: databaseURL,
		JWTSecret:   tmResp.Data.JWTSecret,
	}

	// Pre-build JWT configuration with tenant secret for signing/verification
	if tmResp.Data.JWTSecret != "" && m.baseJWTConfig != nil {
		jwtConfig, err := conf.BuildJWTConfigFromSecret(*m.baseJWTConfig, tmResp.Data.JWTSecret)
		if err != nil {
			return nil, fmt.Errorf("failed to build JWT config for tenant %s: %w", tenantID, err)
		}
		tenantConfig.JWTConfig = &jwtConfig
	}

	logrus.WithFields(logrus.Fields{
		"tenant_id": tenantID,
		"db_host":   creds.Host,
		"db_name":   creds.DBName,
	}).Debug("Fetched tenant configuration")

	return tenantConfig, nil
}

// fetchDBCredentials fetches database credentials from the tenant-manager database-credentials API
func (m *Manager) fetchDBCredentials(ctx context.Context, tenantID string) (*dbCredentials, error) {
	reqURL := fmt.Sprintf("%s/admin/v1/projects/%s/database-credentials", m.config.TenantManagerURL, tenantID)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+m.config.TenantManagerKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := m.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch database credentials: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("database-credentials API returned status %d for tenant %s", resp.StatusCode, tenantID)
	}

	var credResp dbCredentialsResponse
	if err := json.NewDecoder(resp.Body).Decode(&credResp); err != nil {
		return nil, fmt.Errorf("failed to decode database credentials response: %w", err)
	}

	return &credResp.Data, nil
}

// InvalidateCache removes a tenant from the cache
func (m *Manager) InvalidateCache(tenantID string) {
	m.cacheMu.Lock()
	delete(m.cache, tenantID)
	m.cacheMu.Unlock()
}

// CleanupExpiredCache removes expired entries from the cache
func (m *Manager) CleanupExpiredCache() {
	m.cacheMu.Lock()
	defer m.cacheMu.Unlock()

	now := time.Now()
	for tenantID, entry := range m.cache {
		if now.After(entry.expiresAt) {
			delete(m.cache, tenantID)
		}
	}
}

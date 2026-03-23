package tenant

import (
	"net/http"
	"strings"

	"github.com/sirupsen/logrus"
)

var exemptPaths = []string{"/health", "/.well-known/"}

func isExemptPath(path string) bool {
	for _, p := range exemptPaths {
		if path == p || strings.HasPrefix(path, p) {
			return true
		}
	}
	return false
}

const (
	// TenantIDHeader is the HTTP header used to identify the tenant
	TenantIDHeader = "X-Tenant-Id"
)

// Handler returns a middleware that extracts tenant ID and injects tenant context
func Handler(pool *ConnectionPool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			tenantID := r.Header.Get(TenantIDHeader)

			// If no tenant ID is provided, only allow exempt paths
			if tenantID == "" {
				if isExemptPath(r.URL.Path) {
					next.ServeHTTP(w, r)
					return
				}
				http.Error(w, `{"code":400,"msg":"X-Tenant-Id header is required"}`, http.StatusBadRequest)
				return
			}

			ctx := r.Context()

			// Get tenant connection from pool
			conn, config, err := pool.GetConnection(ctx, tenantID)
			if err != nil {
				logrus.WithError(err).WithField("tenant_id", tenantID).Error("Failed to get tenant connection")
				http.Error(w, "Invalid tenant", http.StatusBadRequest)
				return
			}

			// Create tenant context
			tc := &TenantContext{
				TenantID:   tenantID,
				Connection: conn,
				Config:     config,
			}

			// Inject tenant context into request context
			ctx = SetTenantInContext(ctx, tc)
			r = r.WithContext(ctx)

			next.ServeHTTP(w, r)
		})
	}
}

// GetTenantID extracts tenant ID from the request header
func GetTenantID(r *http.Request) string {
	return r.Header.Get(TenantIDHeader)
}

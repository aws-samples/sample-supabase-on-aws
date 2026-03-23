package tenant

import (
	"context"
)

type contextKey string

const tenantContextKey contextKey = "tenant_context"

// SetTenantInContext stores the TenantContext in the request context
func SetTenantInContext(ctx context.Context, tc *TenantContext) context.Context {
	return context.WithValue(ctx, tenantContextKey, tc)
}

// GetTenantFromContext retrieves the TenantContext from the request context
func GetTenantFromContext(ctx context.Context) (*TenantContext, bool) {
	tc, ok := ctx.Value(tenantContextKey).(*TenantContext)
	return tc, ok
}

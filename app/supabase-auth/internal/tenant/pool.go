package tenant

import (
	"container/list"
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/sirupsen/logrus"
	"github.com/supabase/auth/internal/conf"
	"github.com/supabase/auth/internal/storage"
)

// poolEntry holds a database connection with metadata for LRU eviction
type poolEntry struct {
	tenantID string
	conn     *storage.Connection
	config   *TenantConfig
	lastUsed time.Time
	element  *list.Element
}

// ConnectionPool manages database connections for multiple tenants using LRU eviction
type ConnectionPool struct {
	manager       *Manager
	globalConfig  *conf.GlobalConfiguration
	connections   map[string]*poolEntry
	lruList       *list.List
	mu            sync.RWMutex
	maxSize       int
	maxIdleTime   time.Duration
	cleanupTicker *time.Ticker
	stopCleanup   chan struct{}
}

// NewConnectionPool creates a new connection pool
func NewConnectionPool(manager *Manager, globalConfig *conf.GlobalConfiguration) *ConnectionPool {
	pool := &ConnectionPool{
		manager:      manager,
		globalConfig: globalConfig,
		connections:  make(map[string]*poolEntry),
		lruList:      list.New(),
		maxSize:      globalConfig.MultiTenant.MaxConnections,
		maxIdleTime:  globalConfig.MultiTenant.MaxIdleTime,
		stopCleanup:  make(chan struct{}),
	}

	// Start background cleanup
	pool.cleanupTicker = time.NewTicker(1 * time.Minute)
	go pool.cleanupLoop()

	return pool
}

// GetConnection retrieves or creates a database connection for the given tenant
func (p *ConnectionPool) GetConnection(ctx context.Context, tenantID string) (*storage.Connection, *TenantConfig, error) {
	// Try to get from pool first
	p.mu.RLock()
	if entry, ok := p.connections[tenantID]; ok {
		entry.lastUsed = time.Now()
		// Move to front of LRU list
		p.lruList.MoveToFront(entry.element)
		p.mu.RUnlock()
		return entry.conn, entry.config, nil
	}
	p.mu.RUnlock()

	// Get tenant config
	config, err := p.manager.GetTenantConfig(ctx, tenantID)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to get tenant config: %w", err)
	}

	// Create new connection
	conn, err := p.createConnection(ctx, config)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to create connection for tenant %s: %w", tenantID, err)
	}

	// Add to pool
	p.mu.Lock()
	defer p.mu.Unlock()

	// Check again in case another goroutine added it
	if entry, ok := p.connections[tenantID]; ok {
		// Close the connection we just created
		conn.Close()
		entry.lastUsed = time.Now()
		p.lruList.MoveToFront(entry.element)
		return entry.conn, entry.config, nil
	}

	// Evict if necessary
	if len(p.connections) >= p.maxSize {
		p.evictOldest()
	}

	entry := &poolEntry{
		tenantID: tenantID,
		conn:     conn,
		config:   config,
		lastUsed: time.Now(),
	}
	entry.element = p.lruList.PushFront(entry)
	p.connections[tenantID] = entry

	logrus.WithFields(logrus.Fields{
		"tenant_id": tenantID,
		"pool_size": len(p.connections),
	}).Debug("Created new tenant database connection")

	return conn, config, nil
}

// createConnection creates a new database connection for the tenant
func (p *ConnectionPool) createConnection(ctx context.Context, config *TenantConfig) (*storage.Connection, error) {
	return storage.DialWithURL(ctx, config.DatabaseURL, p.globalConfig)
}

// evictOldest removes the least recently used connection
func (p *ConnectionPool) evictOldest() {
	oldest := p.lruList.Back()
	if oldest == nil {
		return
	}

	entry := oldest.Value.(*poolEntry)
	p.lruList.Remove(oldest)
	delete(p.connections, entry.tenantID)

	if err := entry.conn.Close(); err != nil {
		logrus.WithError(err).WithField("tenant_id", entry.tenantID).Warn("Error closing evicted connection")
	}

	logrus.WithField("tenant_id", entry.tenantID).Debug("Evicted tenant connection from pool")
}

// cleanupLoop periodically removes idle connections
func (p *ConnectionPool) cleanupLoop() {
	for {
		select {
		case <-p.cleanupTicker.C:
			p.cleanupIdle()
			p.manager.CleanupExpiredCache()
		case <-p.stopCleanup:
			return
		}
	}
}

// cleanupIdle removes connections that have been idle for too long
func (p *ConnectionPool) cleanupIdle() {
	p.mu.Lock()
	defer p.mu.Unlock()

	now := time.Now()
	for tenantID, entry := range p.connections {
		if now.Sub(entry.lastUsed) > p.maxIdleTime {
			p.lruList.Remove(entry.element)
			delete(p.connections, tenantID)

			if err := entry.conn.Close(); err != nil {
				logrus.WithError(err).WithField("tenant_id", tenantID).Warn("Error closing idle connection")
			}

			logrus.WithField("tenant_id", tenantID).Debug("Removed idle tenant connection")
		}
	}
}

// Close closes all connections and stops the cleanup loop
func (p *ConnectionPool) Close() error {
	close(p.stopCleanup)
	p.cleanupTicker.Stop()

	p.mu.Lock()
	defer p.mu.Unlock()

	var firstErr error
	for tenantID, entry := range p.connections {
		if err := entry.conn.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
		delete(p.connections, tenantID)
	}

	return firstErr
}

// Size returns the current number of connections in the pool
func (p *ConnectionPool) Size() int {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return len(p.connections)
}

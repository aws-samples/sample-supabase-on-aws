/**
 * GET /api/admin/v1/metrics/platform
 * 
 * Get aggregated platform-wide metrics over a time range
 * This is a proxy endpoint that calls the MetricsAggregator service
 * 
 * Requirements: 18.6, 18.8
 */

import type { NextApiRequest, NextApiResponse } from 'next'
import { withClusterAuth, type ClusterApiContext } from '../../../../../lib/cluster-management/cluster-api-wrapper'
import type { AuthenticatedRequest } from '../../../../../lib/cluster-management/auth-middleware'
import { MetricsAggregator } from '../../../../../lib/cluster-management/metrics-aggregator'
import { Pool } from 'pg'

async function platformMetricsHandler(
  req: AuthenticatedRequest,
  res: NextApiResponse,
  _context: ClusterApiContext
) {
  const { method } = req

  if (method !== 'GET') {
    res.setHeader('Allow', ['GET'])
    return res.status(405).json({
      error: {
        code: 'METHOD_NOT_ALLOWED',
        message: `Method ${method} not allowed`,
      },
    })
  }

  try {
    const { start_time, end_time, interval } = req.query

    // Validate required parameters
    if (!start_time || !end_time) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Missing required query parameters',
          details: {
            required: ['start_time', 'end_time'],
          },
        },
      })
    }

    // Parse dates
    const startTime = new Date(start_time as string)
    const endTime = new Date(end_time as string)

    // Validate dates
    if (isNaN(startTime.getTime()) || isNaN(endTime.getTime())) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid date format',
          details: {
            start_time: 'Must be a valid ISO 8601 date string',
            end_time: 'Must be a valid ISO 8601 date string',
          },
        },
      })
    }

    // Validate time range
    if (startTime >= endTime) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid time range',
          details: {
            message: 'start_time must be before end_time',
          },
        },
      })
    }

    // Validate interval if provided
    const validIntervals = ['5m', '1h', '1d']
    if (interval && !validIntervals.includes(interval as string)) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid interval',
          details: {
            interval: 'Must be one of: 5m, 1h, 1d',
          },
        },
      })
    }

    // Get database pool and create aggregator
    const connectionString = process.env.DATABASE_URL || 
      `postgresql://${process.env.POSTGRES_USER || 'postgres'}:${process.env.POSTGRES_PASSWORD}@${process.env.POSTGRES_HOST || 'localhost'}:${process.env.POSTGRES_PORT || 5432}/${process.env.POSTGRES_DB || 'postgres'}`

    if (!connectionString) {
      return res.status(500).json({
        error: {
          code: 'CONFIGURATION_ERROR',
          message: 'Database connection not configured',
        },
      })
    }

    const pool = new Pool({ connectionString })
    const aggregator = new MetricsAggregator(pool)

    // Aggregate metrics
    const result = await aggregator.aggregatePlatformMetrics(
      startTime,
      endTime,
      interval as '5m' | '1h' | '1d' | undefined
    )

    return res.status(200).json(result)
  } catch (error: any) {
    console.error('Platform metrics aggregation error:', error)
    return res.status(500).json({
      error: {
        code: 'AGGREGATION_FAILED',
        message: 'Failed to aggregate platform metrics',
        details: error.message,
      },
    })
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  return withClusterAuth(req, res, platformMetricsHandler, {
    requireOrganization: false,
    action: 'read',
    resourceType: 'cluster',
  })
}


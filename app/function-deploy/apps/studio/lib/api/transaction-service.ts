import { getProjectDatabaseClient } from './project-database-client'
import { getContainerLoggingService } from './container-logging-service'

/**
 * Transaction Service
 * Handles transaction support for PostgREST operations
 * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5
 */
export class TransactionService {
  private static instance: TransactionService
  private activeTransactions = new Map<string, TransactionContext>()
  private transactionTimeouts = new Map<string, NodeJS.Timeout>()
  private projectDatabaseClient = getProjectDatabaseClient()
  private loggingService = getContainerLoggingService()
  private readonly DEFAULT_TIMEOUT = 30000 // 30 seconds
  private readonly MAX_TIMEOUT = 300000 // 5 minutes

  private constructor() {}

  static getInstance(): TransactionService {
    if (!TransactionService.instance) {
      TransactionService.instance = new TransactionService()
    }
    return TransactionService.instance
  }

  /**
   * Begin a new transaction
   * Requirements: 10.1, 10.2
   */
  async beginTransaction(
    projectRef: string,
    userId: string,
    options?: TransactionOptions
  ): Promise<TransactionContext> {
    const transactionId = this.generateTransactionId()
    const timeout = Math.min(options?.timeout || this.DEFAULT_TIMEOUT, this.MAX_TIMEOUT)

    try {
      // Start database transaction
      const result = await this.projectDatabaseClient.queryProjectDatabase(
        projectRef,
        userId,
        'BEGIN',
        []
      )

      const context: TransactionContext = {
        id: transactionId,
        projectRef,
        userId,
        startTime: new Date(),
        operations: [],
        status: 'active',
        timeout,
        isolationLevel: options?.isolationLevel || 'READ COMMITTED'
      }

      // Set isolation level if specified
      if (options?.isolationLevel && options.isolationLevel !== 'READ COMMITTED') {
        await this.projectDatabaseClient.queryProjectDatabase(
          projectRef,
          userId,
          `SET TRANSACTION ISOLATION LEVEL ${options.isolationLevel}`,
          []
        )
      }

      // Store transaction context
      this.activeTransactions.set(transactionId, context)

      // Set timeout handler
      const timeoutHandler = setTimeout(async () => {
        await this.handleTransactionTimeout(transactionId)
      }, timeout)
      this.transactionTimeouts.set(transactionId, timeoutHandler)

      // Log transaction start
      this.loggingService.info(projectRef, 'Transaction started', {
        transactionId,
        userId,
        timeout,
        isolationLevel: context.isolationLevel
      }, 'transaction-service')

      return context
    } catch (error) {
      this.loggingService.error(projectRef, 'Failed to begin transaction', {
        transactionId,
        userId,
        error: error instanceof Error ? error.message : 'Unknown error'
      }, 'transaction-service')
      throw error
    }
  }

  /**
   * Execute operation within transaction
   * Requirements: 10.1, 10.2
   */
  async executeInTransaction(
    transactionId: string,
    operation: DatabaseOperation
  ): Promise<any> {
    const context = this.activeTransactions.get(transactionId)
    if (!context) {
      throw new Error(`Transaction ${transactionId} not found`)
    }

    if (context.status !== 'active') {
      throw new Error(`Transaction ${transactionId} is not active (status: ${context.status})`)
    }

    try {
      // Add operation to context
      context.operations.push({
        ...operation,
        timestamp: new Date()
      })

      // Execute the operation
      const result = await this.projectDatabaseClient.queryProjectDatabase(
        context.projectRef,
        context.userId,
        operation.sql,
        operation.params || []
      )

      // Log operation
      this.loggingService.debug(context.projectRef, 'Transaction operation executed', {
        transactionId,
        operationType: operation.type,
        operationCount: context.operations.length
      }, 'transaction-service')

      return result
    } catch (error) {
      // Mark transaction as failed
      context.status = 'failed'
      context.error = error instanceof Error ? error.message : 'Unknown error'

      this.loggingService.error(context.projectRef, 'Transaction operation failed', {
        transactionId,
        operationType: operation.type,
        error: context.error
      }, 'transaction-service')

      throw error
    }
  }

  /**
   * Commit transaction
   * Requirements: 10.2, 10.3
   */
  async commitTransaction(transactionId: string): Promise<TransactionResult> {
    const context = this.activeTransactions.get(transactionId)
    if (!context) {
      throw new Error(`Transaction ${transactionId} not found`)
    }

    if (context.status !== 'active') {
      throw new Error(`Transaction ${transactionId} is not active (status: ${context.status})`)
    }

    try {
      // Commit the transaction
      await this.projectDatabaseClient.queryProjectDatabase(
        context.projectRef,
        context.userId,
        'COMMIT',
        []
      )

      // Update context
      context.status = 'committed'
      context.endTime = new Date()

      // Clear timeout
      this.clearTransactionTimeout(transactionId)

      // Calculate execution time
      const executionTime = context.endTime.getTime() - context.startTime.getTime()

      const result: TransactionResult = {
        transactionId,
        status: 'committed',
        operationCount: context.operations.length,
        executionTime,
        startTime: context.startTime,
        endTime: context.endTime
      }

      // Log successful commit
      this.loggingService.info(context.projectRef, 'Transaction committed', {
        transactionId,
        operationCount: context.operations.length,
        executionTime
      }, 'transaction-service')

      // Clean up
      this.activeTransactions.delete(transactionId)

      return result
    } catch (error) {
      // Mark as failed and attempt rollback
      context.status = 'failed'
      context.error = error instanceof Error ? error.message : 'Unknown error'

      this.loggingService.error(context.projectRef, 'Transaction commit failed', {
        transactionId,
        error: context.error
      }, 'transaction-service')

      // Attempt rollback
      await this.rollbackTransaction(transactionId)
      throw error
    }
  }

  /**
   * Rollback transaction
   * Requirements: 10.2, 10.3
   */
  async rollbackTransaction(transactionId: string): Promise<TransactionResult> {
    const context = this.activeTransactions.get(transactionId)
    if (!context) {
      throw new Error(`Transaction ${transactionId} not found`)
    }

    try {
      // Rollback the transaction
      await this.projectDatabaseClient.queryProjectDatabase(
        context.projectRef,
        context.userId,
        'ROLLBACK',
        []
      )

      // Update context
      context.status = 'rolled_back'
      context.endTime = new Date()

      // Clear timeout
      this.clearTransactionTimeout(transactionId)

      // Calculate execution time
      const executionTime = context.endTime.getTime() - context.startTime.getTime()

      const result: TransactionResult = {
        transactionId,
        status: 'rolled_back',
        operationCount: context.operations.length,
        executionTime,
        startTime: context.startTime,
        endTime: context.endTime,
        error: context.error
      }

      // Log rollback
      this.loggingService.info(context.projectRef, 'Transaction rolled back', {
        transactionId,
        operationCount: context.operations.length,
        executionTime,
        error: context.error
      }, 'transaction-service')

      // Clean up
      this.activeTransactions.delete(transactionId)

      return result
    } catch (error) {
      this.loggingService.error(context.projectRef, 'Transaction rollback failed', {
        transactionId,
        error: error instanceof Error ? error.message : 'Unknown error'
      }, 'transaction-service')

      // Force cleanup even if rollback failed
      this.activeTransactions.delete(transactionId)
      this.clearTransactionTimeout(transactionId)

      throw error
    }
  }

  /**
   * Get transaction status
   * Requirements: 10.1
   */
  getTransactionStatus(transactionId: string): TransactionStatus | null {
    const context = this.activeTransactions.get(transactionId)
    if (!context) {
      return null
    }

    const currentTime = new Date()
    const elapsedTime = currentTime.getTime() - context.startTime.getTime()
    const remainingTime = Math.max(0, context.timeout - elapsedTime)

    return {
      transactionId: context.id,
      status: context.status,
      startTime: context.startTime,
      elapsedTime,
      remainingTime,
      operationCount: context.operations.length,
      isolationLevel: context.isolationLevel,
      error: context.error
    }
  }

  /**
   * Handle transaction timeout
   * Requirements: 10.4
   */
  private async handleTransactionTimeout(transactionId: string): Promise<void> {
    const context = this.activeTransactions.get(transactionId)
    if (!context || context.status !== 'active') {
      return
    }

    try {
      context.status = 'timed_out'
      context.error = 'Transaction timed out'

      this.loggingService.warn(context.projectRef, 'Transaction timed out', {
        transactionId,
        timeout: context.timeout,
        operationCount: context.operations.length
      }, 'transaction-service')

      // Force rollback
      await this.rollbackTransaction(transactionId)
    } catch (error) {
      this.loggingService.error(context.projectRef, 'Failed to handle transaction timeout', {
        transactionId,
        error: error instanceof Error ? error.message : 'Unknown error'
      }, 'transaction-service')
    }
  }

  /**
   * Handle deadlock detection and recovery
   * Requirements: 10.5
   */
  async handleDeadlock(transactionId: string, error: any): Promise<void> {
    const context = this.activeTransactions.get(transactionId)
    if (!context) {
      return
    }

    // Check if this is a deadlock error
    const isDeadlock = this.isDeadlockError(error)
    if (!isDeadlock) {
      return
    }

    try {
      context.status = 'deadlocked'
      context.error = 'Transaction deadlocked'

      this.loggingService.warn(context.projectRef, 'Transaction deadlock detected', {
        transactionId,
        operationCount: context.operations.length,
        error: error instanceof Error ? error.message : 'Unknown error'
      }, 'transaction-service')

      // Automatic rollback for deadlocked transaction
      await this.rollbackTransaction(transactionId)
    } catch (rollbackError) {
      this.loggingService.error(context.projectRef, 'Failed to handle deadlock', {
        transactionId,
        originalError: error instanceof Error ? error.message : 'Unknown error',
        rollbackError: rollbackError instanceof Error ? rollbackError.message : 'Unknown error'
      }, 'transaction-service')
    }
  }

  /**
   * Check if error is a deadlock error
   * Requirements: 10.5
   */
  private isDeadlockError(error: any): boolean {
    if (!error) return false
    
    const errorMessage = error.message || error.toString()
    const errorCode = error.code

    // PostgreSQL deadlock error codes and messages
    return errorCode === '40P01' || // deadlock_detected
           errorCode === '40001' || // serialization_failure
           errorMessage.toLowerCase().includes('deadlock') ||
           errorMessage.toLowerCase().includes('could not serialize access')
  }

  /**
   * Clear transaction timeout
   */
  private clearTransactionTimeout(transactionId: string): void {
    const timeout = this.transactionTimeouts.get(transactionId)
    if (timeout) {
      clearTimeout(timeout)
      this.transactionTimeouts.delete(transactionId)
    }
  }

  /**
   * Generate unique transaction ID
   */
  private generateTransactionId(): string {
    return `tx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  }

  /**
   * Get all active transactions for a project
   * Requirements: 10.1
   */
  getActiveTransactions(projectRef: string): TransactionStatus[] {
    const activeTransactions: TransactionStatus[] = []
    
    for (const [transactionId, context] of this.activeTransactions) {
      if (context.projectRef === projectRef && context.status === 'active') {
        const currentTime = new Date()
        const elapsedTime = currentTime.getTime() - context.startTime.getTime()
        const remainingTime = Math.max(0, context.timeout - elapsedTime)

        activeTransactions.push({
          transactionId: context.id,
          status: context.status,
          startTime: context.startTime,
          elapsedTime,
          remainingTime,
          operationCount: context.operations.length,
          isolationLevel: context.isolationLevel,
          error: context.error
        })
      }
    }

    return activeTransactions
  }

  /**
   * Cleanup expired transactions
   * Requirements: 10.4
   */
  async cleanupExpiredTransactions(): Promise<void> {
    const currentTime = new Date()
    const expiredTransactions: string[] = []

    for (const [transactionId, context] of this.activeTransactions) {
      const elapsedTime = currentTime.getTime() - context.startTime.getTime()
      if (elapsedTime > context.timeout && context.status === 'active') {
        expiredTransactions.push(transactionId)
      }
    }

    for (const transactionId of expiredTransactions) {
      await this.handleTransactionTimeout(transactionId)
    }
  }

  /**
   * Get transaction statistics
   * Requirements: 10.1
   */
  getTransactionStatistics(projectRef?: string): TransactionStatistics {
    let totalTransactions = 0
    let activeTransactions = 0
    let committedTransactions = 0
    let rolledBackTransactions = 0
    let timedOutTransactions = 0
    let deadlockedTransactions = 0

    for (const [_, context] of this.activeTransactions) {
      if (!projectRef || context.projectRef === projectRef) {
        totalTransactions++
        switch (context.status) {
          case 'active':
            activeTransactions++
            break
          case 'committed':
            committedTransactions++
            break
          case 'rolled_back':
            rolledBackTransactions++
            break
          case 'timed_out':
            timedOutTransactions++
            break
          case 'deadlocked':
            deadlockedTransactions++
            break
        }
      }
    }

    return {
      totalTransactions,
      activeTransactions,
      committedTransactions,
      rolledBackTransactions,
      timedOutTransactions,
      deadlockedTransactions
    }
  }
}

/**
 * Transaction context interface
 * Requirements: 10.1, 10.2
 */
export interface TransactionContext {
  id: string
  projectRef: string
  userId: string
  startTime: Date
  endTime?: Date
  operations: DatabaseOperationWithTimestamp[]
  status: TransactionStatus['status']
  timeout: number
  isolationLevel: string
  error?: string
}

/**
 * Database operation interface
 * Requirements: 10.1, 10.2
 */
export interface DatabaseOperation {
  type: 'select' | 'insert' | 'update' | 'delete' | 'rpc' | 'ddl'
  sql: string
  params?: any[]
  table?: string
  function?: string
}

/**
 * Database operation with timestamp
 */
export interface DatabaseOperationWithTimestamp extends DatabaseOperation {
  timestamp: Date
}

/**
 * Transaction options interface
 * Requirements: 10.1, 10.4
 */
export interface TransactionOptions {
  timeout?: number
  isolationLevel?: 'READ UNCOMMITTED' | 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE'
}

/**
 * Transaction result interface
 * Requirements: 10.2, 10.3
 */
export interface TransactionResult {
  transactionId: string
  status: 'committed' | 'rolled_back'
  operationCount: number
  executionTime: number
  startTime: Date
  endTime: Date
  error?: string
}

/**
 * Transaction status interface
 * Requirements: 10.1
 */
export interface TransactionStatus {
  transactionId: string
  status: 'active' | 'committed' | 'rolled_back' | 'failed' | 'timed_out' | 'deadlocked'
  startTime: Date
  elapsedTime: number
  remainingTime: number
  operationCount: number
  isolationLevel: string
  error?: string
}

/**
 * Transaction statistics interface
 * Requirements: 10.1
 */
export interface TransactionStatistics {
  totalTransactions: number
  activeTransactions: number
  committedTransactions: number
  rolledBackTransactions: number
  timedOutTransactions: number
  deadlockedTransactions: number
}

/**
 * Factory function to get the transaction service
 */
export function getTransactionService(): TransactionService {
  return TransactionService.getInstance()
}
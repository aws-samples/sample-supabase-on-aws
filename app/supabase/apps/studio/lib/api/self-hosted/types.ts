import z from 'zod/v4'

export type WrappedSuccessResult<T> = { data: T; error: undefined }
export type WrappedErrorResult = { data: undefined; error: Error }
export type WrappedResult<R> = WrappedSuccessResult<R> | WrappedErrorResult

export const databaseErrorSchema = z
  .object({
    message: z.string().optional(),
    error: z.string().optional(),
    code: z.string().optional().default('UNKNOWN'),
    formattedError: z.string().optional().default(''),
  })
  .transform((data) => ({
    message: data.message ?? data.error ?? 'Unknown database error',
    code: data.code!,
    formattedError: data.formattedError!,
  }))

export class PgMetaDatabaseError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number,
    public formattedError: string
  ) {
    super(message)
    this.name = 'PgMetaDatabaseError'
  }
}

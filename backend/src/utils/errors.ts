export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export class NotFoundError extends AppError {
  constructor(entity: string, id?: string) {
    super(404, `${entity}${id ? ` ${id}` : ''} not found`, 'NOT_FOUND');
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(400, message, 'VALIDATION_ERROR', details);
  }
}

export class StockInsufficientError extends AppError {
  constructor(variantId: string, branchId: string, available: number, requested: number) {
    super(409, `Stock insuficiente`, 'STOCK_INSUFFICIENT', { variantId, branchId, available, requested });
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super(409, message, 'CONFLICT', details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(401, message, 'UNAUTHORIZED');
  }
}

/**
 * Error codes และ error envelope กลางของระบบ — ดู docs/conventions.md
 * UI/clients ตัดสินใจจาก `code` เท่านั้น ไม่ parse `message`
 */

export const ERROR_CODES = {
  // generic
  INTERNAL_ERROR: 500,
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,

  // auth (phase 1)
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  CSRF_REJECTED: 403,
  INVALID_CREDENTIALS: 401,

  // projects (phase 1)
  PROJECT_NOT_FOUND: 404,
  PROJECT_ARCHIVED: 409,

  // github (phase 2)
  GITHUB_UNAVAILABLE: 502,
  INSTALLATION_NOT_FOUND: 404,
  WEBHOOK_SIGNATURE_INVALID: 401,
  WEBHOOK_DUPLICATE_DELIVERY: 409,

  // deployments (phase 3)
  DEPLOYMENT_NOT_FOUND: 404,
  DEPLOY_ALREADY_ACTIVE: 409,
  INVALID_STATE_TRANSITION: 409,
  CLONE_FAILED: 502,
  DOCKERFILE_NOT_FOUND: 422,
  BUILD_FAILED: 500,
  BUILD_TIMEOUT: 504,
  HEALTH_CHECK_FAILED: 500,
  DOCKER_UNAVAILABLE: 503,
  CONTAINER_CRASH_LOOP: 500,
  DEPLOY_TIMEOUT_EXCEEDED: 504,
  WORKSPACE_ERROR: 500,
  ROLLBACK_TARGET_UNAVAILABLE: 422,
  ROLLBACK_IMAGE_UNAVAILABLE: 422,
  DISK_FULL: 507,

  // system
  NOT_READY: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    requestId: string;
    details?: Record<string, unknown>;
  };
}

/** Error ที่ตั้งใจโยนจาก business logic — ถูก map เป็น envelope + HTTP status โดย API layer */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }

  get status(): number {
    return ERROR_CODES[this.code];
  }
}

export function toErrorEnvelope(error: AppError, requestId: string): ErrorEnvelope {
  return {
    error: {
      code: error.code,
      message: error.message,
      requestId,
      ...(error.details ? { details: error.details } : {}),
    },
  };
}

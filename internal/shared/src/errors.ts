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

  // web security (phase 8 M5)
  INVALID_HOST: 400,
  INVALID_ORIGIN: 403,

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
  WORKSPACE_TOO_LARGE: 413,
  ROLLBACK_TARGET_UNAVAILABLE: 422,
  ROLLBACK_IMAGE_UNAVAILABLE: 422,
  DISK_FULL: 507,

  // environment variables (phase 4)
  ENV_VAR_NOT_FOUND: 404,
  ENV_VAR_DUPLICATE_KEY: 409,
  ENV_VAR_INVALID_KEY: 422,
  ENV_ENCRYPTION_NOT_CONFIGURED: 503,

  // domains (phase 5)
  DOMAIN_NOT_FOUND: 404,
  DOMAIN_DUPLICATE: 409,
  DOMAIN_INVALID: 422,
  DOMAIN_WILDCARD_NOT_ALLOWED: 422,
  DOMAIN_RESERVED: 422,

  // custom TLS certificates (phase 5 M5)
  TLS_CERT_INVALID: 422,
  TLS_KEY_INVALID: 422,
  TLS_CERT_KEY_MISMATCH: 422,
  TLS_CERT_EXPIRED: 422,
  TLS_CERT_HOSTNAME_MISMATCH: 422,
  TLS_CERT_NOT_FOUND: 404,
  TLS_ENCRYPTION_NOT_CONFIGURED: 503,
  TLS_MATERIALIZE_FAILED: 500,

  // volumes (phase 7)
  VOLUME_NOT_FOUND: 404,
  VOLUME_DUPLICATE_MOUNT: 409,
  VOLUME_INVALID_PATH: 422,
  VOLUME_SENSITIVE_PATH: 422,
  VOLUME_DRIVER_NOT_ALLOWED: 422,
  VOLUME_NOT_DETACHED: 409,
  VOLUME_IN_USE: 409,
  VOLUME_CREATE_FAILED: 500,

  // managed services / databases (phase 10)
  SERVICE_NOT_FOUND: 404,
  SERVICE_DUPLICATE_NAME: 409,
  SERVICE_TYPE_INVALID: 422,
  SERVICE_VERSION_INVALID: 422,
  SERVICE_PORT_IN_USE: 409,
  SERVICE_PORT_RESERVED: 422,
  SERVICE_PORT_OUT_OF_RANGE: 422,
  SERVICE_NOT_STOPPED: 409,
  SERVICE_PROVISION_FAILED: 500,
  SERVICE_BUSY: 409,

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

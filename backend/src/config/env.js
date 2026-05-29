export function validateEnv() {
  const errors = [];
  const isProduction = process.env.NODE_ENV === 'production';

  if (!process.env.ADMIN_USERNAME) {
    errors.push('ADMIN_USERNAME is required.');
  }

  if (!process.env.ADMIN_PASSWORD && !process.env.ADMIN_PASSWORD_HASH) {
    errors.push('ADMIN_PASSWORD or ADMIN_PASSWORD_HASH is required.');
  }

  if (!process.env.JWT_SECRET) {
    errors.push('JWT_SECRET is required.');
  } else if (process.env.JWT_SECRET.length < 32) {
    errors.push('JWT_SECRET must be at least 32 characters.');
  }

  if (!process.env.ENCRYPTION_KEY) {
    errors.push('ENCRYPTION_KEY is required.');
  } else if (process.env.ENCRYPTION_KEY.length < 32) {
    errors.push('ENCRYPTION_KEY must be at least 32 characters.');
  }

  if (process.env.PORT && (!Number.isInteger(Number(process.env.PORT)) || Number(process.env.PORT) < 1 || Number(process.env.PORT) > 65535)) {
    errors.push('PORT must be a valid TCP port.');
  }

  if (isProduction && !process.env.DATABASE_URL) {
    errors.push('DATABASE_URL is required for the OCI inventory PostgreSQL database.');
  }

  if (isProduction && process.env.JWT_SECRET === 'replace-with-a-long-random-secret') {
    errors.push('JWT_SECRET must be changed for production.');
  }

  if (isProduction && process.env.ENCRYPTION_KEY === 'replace-with-a-different-long-random-secret') {
    errors.push('ENCRYPTION_KEY must be changed for production.');
  }

  if (isProduction && process.env.ADMIN_PASSWORD === 'change-me-in-production') {
    console.warn('ADMIN_PASSWORD is using the local development default. Change it before real use.');
  }

  if (isProduction && process.env.COOKIE_SECURE !== 'true') {
    console.warn('COOKIE_SECURE is not true. Use COOKIE_SECURE=true behind HTTPS.');
  }

  if (errors.length > 0) {
    throw new Error(`Invalid environment: ${errors.join(' ')}`);
  }
}

const secretKeyPattern = /(password|secret|token|ticket|authorization|cookie|csrf)/i;

export function redactSecrets(value) {
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        secretKeyPattern.test(key) ? '[redacted]' : redactSecrets(nested),
      ]),
    );
  }

  if (typeof value === 'string' && /PVE(VNC)?[A-Za-z]*:|Bearer\s+|PVEAPIToken=/i.test(value)) {
    return '[redacted]';
  }

  return value;
}

function write(level, message, metadata = {}) {
  const entry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...redactSecrets(metadata),
  };

  const line = JSON.stringify(entry);
  if (level === 'error') {
    console.error(line);
    return;
  }
  if (level === 'warn') {
    console.warn(line);
    return;
  }
  console.log(line);
}

export const logger = {
  info: (message, metadata) => write('info', message, metadata),
  warn: (message, metadata) => write('warn', message, metadata),
  error: (message, metadata) => write('error', message, metadata),
};

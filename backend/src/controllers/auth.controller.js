import bcrypt from 'bcryptjs';
import { timingSafeEqual } from 'crypto';
import jwt from 'jsonwebtoken';
import { appendAuditLog } from '../services/auditLog.js';

const cookieName = 'pm_session';
const sessionMaxAgeSeconds = 60 * 60;
const jwtIssuer = 'multi-cloud-manager';

function requiredSecret() {
  return process.env.JWT_SECRET || 'local-dev-secret';
}

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true',
    maxAge: sessionMaxAgeSeconds * 1000,
    path: '/',
  };
}

function safeEquals(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

async function passwordMatches(password) {
  if (process.env.ADMIN_PASSWORD_HASH) {
    return bcrypt.compare(password, process.env.ADMIN_PASSWORD_HASH);
  }

  return safeEquals(password, process.env.ADMIN_PASSWORD || 'change-me-in-production');
}

function publicUser() {
  return {
    username: process.env.ADMIN_USERNAME || 'admin',
    roles: ['admin'],
  };
}

function issueSession(res, user) {
  const token = jwt.sign(user, requiredSecret(), {
    expiresIn: sessionMaxAgeSeconds,
    issuer: jwtIssuer,
  });

  res.cookie(cookieName, token, cookieOptions());
}

export async function login(req, res) {
  const { username, password } = req.body || {};
  const expectedUsername = process.env.ADMIN_USERNAME || 'admin';

  const validUsername = safeEquals(username, expectedUsername);
  const validPassword = await passwordMatches(password);

  if (!validUsername || !validPassword) {
    await appendAuditLog({
      action: 'login',
      status: 'failed',
      user: username || 'unknown',
      requestId: req.id,
    }).catch(() => undefined);
    return res.status(401).json({ message: 'Invalid username or password.' });
  }

  const user = publicUser();
  issueSession(res, user);
  await appendAuditLog({
    action: 'login',
    status: 'succeeded',
    user: user.username,
    requestId: req.id,
  }).catch(() => undefined);
  return res.json({ user });
}

export async function logout(req, res) {
  let sessionUser = req.user;
  if (!sessionUser && req.cookies?.[cookieName]) {
    try {
      sessionUser = jwt.verify(req.cookies[cookieName], requiredSecret(), {
        issuer: jwtIssuer,
      });
    } catch {
      sessionUser = null;
    }
  }

  await appendAuditLog({
    action: 'logout',
    status: 'succeeded',
    user: sessionUser?.username || 'unknown',
    requestId: req.id,
  }).catch(() => undefined);
  res.clearCookie(cookieName, { ...cookieOptions(), maxAge: 0 });
  res.status(204).send();
}

export function me(req, res) {
  res.json({ user: req.user });
}

export function requireAuth(req, res, next) {
  const token = req.cookies?.[cookieName];
  if (!token) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  try {
    req.user = jwt.verify(token, requiredSecret(), {
      issuer: jwtIssuer,
    });
    return next();
  } catch {
    res.clearCookie(cookieName, { ...cookieOptions(), maxAge: 0 });
    return res.status(401).json({ message: 'Authentication required.' });
  }
}

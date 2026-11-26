import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import {
  deleteSession,
  getAdminUser,
  getSession,
  recordAuditLog,
  saveSession,
  setAdminUser,
} from './store.ts';
import type { SessionRecord } from './types.ts';

export const SESSION_COOKIE_NAME = 'codemind_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

const SESSION_SECRET =
  process.env.CODEMIND_SESSION_SECRET ||
  crypto.createHash('sha256').update(process.env.APP_URL || 'codemind-local-workspace').digest('hex');

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, expectedHex] = stored.split(':');
  if (!salt || !expectedHex) return false;
  const derived = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

function signSessionId(sessionId: string): string {
  const mac = crypto.createHmac('sha256', SESSION_SECRET).update(sessionId).digest('hex');
  return `${sessionId}.${mac}`;
}

function verifySignedSessionId(cookieValue: string): string | null {
  const parts = cookieValue.split('.');
  if (parts.length !== 2) return null;
  const [sessionId, mac] = parts;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(sessionId).digest('hex');
  const actualBuf = Buffer.from(mac, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  if (actualBuf.length !== expectedBuf.length) return null;
  return crypto.timingSafeEqual(actualBuf, expectedBuf) ? sessionId : null;
}

export function issueSessionCookie(res: Response, userId: string, username: string): SessionRecord {
  const sessionId = crypto.randomUUID();
  const csrfToken = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  const session: SessionRecord = { id: sessionId, userId, username, csrfToken, expiresAt };
  saveSession(session);
  recordAuditLog(username, 'USER_LOGIN', 'session', sessionId, `Issued signed session for ${username}`);

  res.cookie(SESSION_COOKIE_NAME, signSessionId(sessionId), {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_MS,
  });

  return session;
}

export function clearSessionCookie(req: Request, res: Response): void {
  const raw = req.cookies?.[SESSION_COOKIE_NAME];
  if (typeof raw === 'string') {
    const sessionId = verifySignedSessionId(raw);
    if (sessionId) {
      const existing = getSession(sessionId);
      if (existing) {
        recordAuditLog(existing.username, 'USER_LOGOUT', 'session', sessionId, `Signed out ${existing.username}`);
      }
      deleteSession(sessionId);
    }
  }
  res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
}

export function resolveSession(req: Request): SessionRecord | null {
  const raw = req.cookies?.[SESSION_COOKIE_NAME];
  if (typeof raw !== 'string') return null;
  const sessionId = verifySignedSessionId(raw);
  if (!sessionId) return null;
  return getSession(sessionId);
}

export function getRequestActor(req: Request): string {
  const sess = (req as Request & { session?: SessionRecord }).session;
  return sess?.username ?? 'workspace-admin';
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const session = resolveSession(req);
  if (!session) {
    res.status(401).json({ detail: 'Authentication required. Please sign in.' });
    return;
  }
  (req as Request & { session?: SessionRecord }).session = session;
  next();
}

export function requireMutationAuth(req: Request, res: Response, next: NextFunction): void {
  const session = resolveSession(req);
  if (!session) {
    res.status(401).json({ detail: 'Authentication required. Please sign in.' });
    return;
  }
  const csrfHeader = req.header('X-CSRF-Token') || '';
  if (!csrfHeader || csrfHeader !== session.csrfToken) {
    res.status(403).json({ detail: 'Invalid or missing CSRF token.' });
    return;
  }
  (req as Request & { session?: SessionRecord }).session = session;
  next();
}

export function createAdminAccount(username: string, password: string) {
  const cleanName = username.trim();
  if (cleanName.length < 3 || cleanName.length > 64) {
    throw new Error('Admin name must be between 3 and 64 characters.');
  }
  if (password.length < 8 || password.length > 1024) {
    throw new Error('Password must be between 8 and 1024 characters.');
  }
  const existing = getAdminUser();
  if (existing) {
    throw new Error('Workspace administrator has already been created.');
  }
  const user = {
    id: crypto.randomUUID(),
    username: cleanName,
    passwordHash: hashPassword(password),
    role: 'admin',
    createdAt: new Date().toISOString(),
  };
  setAdminUser(user);
  return user;
}

export function authenticateAdmin(username: string, password: string) {
  const user = getAdminUser();
  if (!user) return null;
  if (user.username.toLowerCase() !== username.trim().toLowerCase()) return null;
  if (!verifyPassword(password, user.passwordHash)) return null;
  return user;
}

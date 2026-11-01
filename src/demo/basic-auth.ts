import { createHash, timingSafeEqual } from 'crypto';
import { NextFunction, Request, Response } from 'express';

export const DEMO_PASSWORD_ENV = 'ORCHALITE_DEMO_PASSWORD';

/**
 * What must stay open: a signed webhook proves itself, and a run posting to the
 * inbox through the public URL has no password to send.
 */
const OPEN_POSTS = [/^\/hooks\/[^/]+\/?$/i, /^\/inbox\/[^/]+\/?$/i];

const digest = (value: string) => createHash('sha256').update(value).digest();

/** Comparing digests means neither the content nor the length of the password leaks through timing */
function passwordMatches(header: string | undefined, password: string): boolean {
  const [scheme, encoded] = (header ?? '').split(' ');
  if (scheme?.toLowerCase() !== 'basic' || !encoded) return false;
  const credentials = Buffer.from(encoded, 'base64').toString('utf8');
  const given = credentials.slice(credentials.indexOf(':') + 1);
  return credentials.includes(':') && timingSafeEqual(digest(given), digest(password));
}

/**
 * HTTP Basic Auth over the API and UI. Any username is accepted; only the password counts.
 */
export function basicAuth(password: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method === 'POST' && OPEN_POSTS.some(open => open.test(req.path))) return next();
    if (passwordMatches(req.headers.authorization, password)) return next();
    res.setHeader('WWW-Authenticate', 'Basic realm="OrchaLite demo", charset="UTF-8"');
    res.status(401).json({ statusCode: 401, message: 'Password required' });
  };
}

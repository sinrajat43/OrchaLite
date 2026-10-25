import { Type } from '@sinclair/typebox';
import { TaskContext } from './task.interface';

export const ConnectionParam = Type.Optional(
  Type.String({
    pattern: '^[A-Za-z0-9_.-]+$',
    description: 'Named connection: adds its credentials, and makes url relative to its baseUrl',
  })
);

export interface Target {
  url: string;
  headers?: Record<string, string>;
  query?: Record<string, unknown>;
}

/**
 * Applies a named connection to a request. The connection's credentials win
 * over the step's, and are only sent under its baseUrl, so a definition cannot
 * point them at another host.
 */
export async function resolveTarget(
  ctx: TaskContext,
  connectionName: string | undefined,
  { url, headers, query }: Partial<Target>
): Promise<Target> {
  if (!connectionName) {
    if (!url) throw new Error('params.url is required without a connection');
    return { url, headers, query };
  }

  const connection = await ctx.connections.get(connectionName);
  const base = connection.baseUrl.replace(/\/+$/, '');
  let target = base;
  if (url && /^[a-z][a-z0-9+.-]*:/i.test(url)) {
    const inside = url === base || url.startsWith(`${base}/`) || url.startsWith(`${base}?`);
    if (!inside) {
      throw new Error(`params.url is outside connection "${connectionName}" (${base}); its credentials are only sent there`);
    }
    target = url;
  } else if (url) {
    target = `${base}/${url.replace(/^\/+/, '')}`;
  }

  return {
    url: target,
    headers: { ...headers, ...connection.headers },
    query: { ...query, ...connection.query },
  };
}

/** Submit-time check shared by tasks that take url or connection */
export function requireUrlOrConnection(params: Record<string, unknown>): string[] {
  return params.url === undefined && params.connection === undefined
    ? ['params needs url, connection, or both']
    : [];
}

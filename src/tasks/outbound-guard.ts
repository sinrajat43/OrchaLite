import { lookup, LookupAddress, LookupAllOptions, LookupOneOptions } from 'dns';
import { Agent as HttpAgent } from 'http';
import { Agent as HttpsAgent } from 'https';
import { BlockList, isIP } from 'net';
import { AxiosRequestConfig } from 'axios';

export const BLOCK_PRIVATE_NETWORK_ENV = 'ORCHALITE_BLOCK_PRIVATE_NETWORK';

const BLOCKED = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  BLOCKED.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  BLOCKED.addSubnet(network, prefix, 'ipv6');
}

/** Whether an IP address belongs to this machine or a private network; IPv4 inside IPv6 counts as IPv4 */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  return family !== 0 && BLOCKED.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

const blockedError = (target: string) => new Error(`Blocked: ${target} is on a private network`);

function assertPublicLiteral(hostname: string): void {
  const address = hostname.replace(/^\[|\]$/g, '');
  if (isBlockedAddress(address)) throw blockedError(address);
}

/**
 * Checks the address the socket is about to use rather than the name in the
 * URL, so a name that resolves to a private address, even only the second time
 * it is asked, is caught.
 */
function checkedLookup(hostname: string, options: LookupOneOptions | LookupAllOptions, callback: (...args: any[]) => void): void {
  lookup(hostname, options as LookupAllOptions, (error, addresses: LookupAddress[] | string, family?: number) => {
    if (error) return callback(error);
    const found = Array.isArray(addresses) ? addresses.map(({ address }) => address) : [addresses];
    if (found.some(isBlockedAddress)) return callback(blockedError(hostname));
    if (Array.isArray(addresses)) return callback(null, addresses);
    callback(null, addresses, family);
  });
}

let agents: { httpAgent: HttpAgent; httpsAgent: HttpsAgent } | undefined;

/**
 * Request options that keep a task from reaching this machine or its network,
 * for when people who aren't trusted with them can run workflows. Empty unless
 * ORCHALITE_BLOCK_PRIVATE_NETWORK is set.
 *
 * Node skips the lookup for a URL holding a bare IP address, so those are
 * checked here, and again on each redirect.
 *
 * @throws Error if the URL holds a private IP address
 */
export function outboundConfig(url: string): AxiosRequestConfig {
  if (!process.env[BLOCK_PRIVATE_NETWORK_ENV]) return {};

  assertPublicLiteral(new URL(url).hostname);
  agents ??= { httpAgent: new HttpAgent({ lookup: checkedLookup }), httpsAgent: new HttpsAgent({ lookup: checkedLookup }) };
  return {
    ...agents,
    // A proxy would do the lookup itself, out of reach of the check
    proxy: false,
    beforeRedirect: options => assertPublicLiteral(String(options.hostname)),
  };
}

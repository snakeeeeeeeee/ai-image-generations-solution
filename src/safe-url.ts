import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent } from 'undici';
import { AppError } from './errors.js';

export interface PinnedHttpTarget {
  dispatcher: Agent;
  close: () => Promise<void>;
}

function ipv4Number(value: string): number | undefined {
  const parts = value.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return undefined;
  }
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
}

function inIpv4Range(value: number, base: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (base & mask);
}

export function isPrivateOrReservedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4Number(address);
    if (value === undefined) return true;
    const ranges: Array<[string, number]> = [
      ['0.0.0.0', 8],
      ['10.0.0.0', 8],
      ['100.64.0.0', 10],
      ['127.0.0.0', 8],
      ['169.254.0.0', 16],
      ['172.16.0.0', 12],
      ['192.0.0.0', 24],
      ['192.0.2.0', 24],
      ['192.168.0.0', 16],
      ['198.18.0.0', 15],
      ['198.51.100.0', 24],
      ['203.0.113.0', 24],
      ['224.0.0.0', 4]
    ];
    return ranges.some(([base, prefix]) => inIpv4Range(value, ipv4Number(base) as number, prefix));
  }
  if (family === 6) {
    const value = address.toLowerCase().split('%', 1)[0];
    if (value === '::' || value === '::1') return true;
    if (value.startsWith('fc') || value.startsWith('fd')) return true;
    if (/^fe[89ab]/.test(value)) return true;
    if (value.startsWith('2001:db8:')) return true;
    const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isPrivateOrReservedAddress(mapped[1]) : false;
  }
  return true;
}

export async function createPinnedHttpTarget(url: URL, allowPrivateNetwork: boolean): Promise<PinnedHttpTarget> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError('Image URL protocol is unsupported', {
      statusCode: 400,
      type: 'invalid_request_error',
      code: 'unsupported_image_url_protocol'
    });
  }
  if (url.username || url.password) {
    throw new AppError('Image URL credentials are not allowed', {
      statusCode: 400,
      type: 'invalid_request_error',
      code: 'image_url_credentials_not_allowed'
    });
  }

  let addresses;
  try {
    addresses = await lookup(url.hostname, { all: true, verbatim: true });
  } catch (error) {
    throw new AppError('Image URL host could not be resolved', {
      statusCode: 502,
      type: 'server_error',
      code: 'image_url_dns_failed',
      cause: error
    });
  }
  if (addresses.length === 0) {
    throw new AppError('Image URL host did not resolve to an address', {
      statusCode: 502,
      type: 'server_error',
      code: 'image_url_dns_failed'
    });
  }
  if (!allowPrivateNetwork && addresses.some((item) => isPrivateOrReservedAddress(item.address))) {
    throw new AppError('Image URL resolves to a private or reserved address', {
      statusCode: 400,
      type: 'invalid_request_error',
      code: 'image_url_private_address'
    });
  }

  const selected = addresses[0];
  const pinnedAddresses = addresses.map((item) => ({ address: item.address, family: item.family }));
  const dispatcher = new Agent({
    connect: {
      lookup: (_hostname, options, callback) => {
        if (options.all) {
          callback(null, pinnedAddresses);
          return;
        }
        callback(null, selected.address, selected.family);
      }
    }
  });
  return {
    dispatcher,
    close: async () => {
      await dispatcher.close();
    }
  };
}

export function assertNoHttpRedirect(response: Response): void {
  if (response.status >= 300 && response.status < 400) {
    throw new AppError('Image URL redirects are not allowed', {
      statusCode: 502,
      type: 'server_error',
      code: 'image_url_redirect_not_allowed'
    });
  }
}

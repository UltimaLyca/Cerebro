/**
 * Scan-target policy for the SpiderFoot investigation bridge.
 *
 * The bridge exists to look at infrastructure and organisations: domains,
 * hostnames, public IPv4 addresses, small public netblocks and autonomous
 * systems. It deliberately refuses every target class that identifies a
 * person (e-mail addresses, phone numbers, quoted names, usernames, crypto
 * addresses), even though SpiderFoot itself accepts them.
 */

const MAX_TARGET_LENGTH = 253;
const MIN_NETBLOCK_PREFIX = 24;

const PRIVATE_V4 = [
  [0, 8],
  [10, 8],
  [100.64, 10],
  [127, 8],
  [169.254, 16],
  [172.16, 12],
  [192.168, 16],
  [224, 4],
  [240, 4],
];

const HOSTNAME =
  /^(?=.{1,253}$)(([a-z0-9]|[a-z0-9][a-z0-9-]{0,61}[a-z0-9])\.)+[a-z]{2,63}$/;
const BLOCKED_SUFFIXES = ['.local', '.localhost', '.internal', '.lan', '.home'];

function ipv4ToInt(text) {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function rangeStart(spec) {
  const [lead, prefix] = spec;
  if (!Number.isInteger(lead)) {
    // 100.64 / 172.16 / 169.254 / 192.168 style two-octet leads.
    const [a, b] = String(lead).split('.').map(Number);
    return [a * 2 ** 24 + b * 2 ** 16, prefix];
  }
  return [lead * 2 ** 24, prefix];
}

function isNonPublicV4(value) {
  for (const spec of PRIVATE_V4) {
    const [start, prefix] = rangeStart(spec);
    const size = 2 ** (32 - prefix);
    if (value >= start && value < start + size) return true;
  }
  return false;
}

/**
 * Classify and normalise a scan target.
 * @param {unknown} input
 * @returns {{ ok: true, kind: 'domain'|'ip'|'netblock'|'asn', value: string }
 *   | { ok: false, reason: string }}
 */
export function classifyTarget(input) {
  if (typeof input !== 'string')
    return { ok: false, reason: 'target must be text' };
  const text = input.trim().toLowerCase();
  if (!text || text.length > MAX_TARGET_LENGTH)
    return { ok: false, reason: 'target is empty or too long' };
  if (/[\s"'<>\\]/.test(text))
    return { ok: false, reason: 'names and quoted values are not accepted' };
  if (text.includes('@'))
    return { ok: false, reason: 'e-mail addresses are not accepted' };
  if (
    /^\+?[\d\s().-]{7,}$/.test(text) &&
    !/^\d{1,3}(\.\d{1,3}){3}(\/\d+)?$/.test(text)
  )
    return { ok: false, reason: 'phone numbers are not accepted' };

  const asn = /^as(\d{1,10})$/.exec(text);
  if (asn) return { ok: true, kind: 'asn', value: asn[1] };

  const cidr = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(text);
  if (cidr) {
    const base = ipv4ToInt(cidr[1]);
    const prefix = Number(cidr[2]);
    if (base === null || prefix > 32)
      return { ok: false, reason: 'invalid netblock' };
    if (prefix < MIN_NETBLOCK_PREFIX)
      return {
        ok: false,
        reason: `netblock is too large; use /${MIN_NETBLOCK_PREFIX} or smaller`,
      };
    if (isNonPublicV4(base))
      return {
        ok: false,
        reason: 'private or reserved addresses are not accepted',
      };
    return { ok: true, kind: 'netblock', value: text };
  }

  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(text)) {
    const value = ipv4ToInt(text);
    if (value === null) return { ok: false, reason: 'invalid IP address' };
    if (isNonPublicV4(value))
      return {
        ok: false,
        reason: 'private or reserved addresses are not accepted',
      };
    return { ok: true, kind: 'ip', value: text };
  }

  if (HOSTNAME.test(text)) {
    if (BLOCKED_SUFFIXES.some((suffix) => text.endsWith(suffix)))
      return { ok: false, reason: 'local names are not accepted' };
    return { ok: true, kind: 'domain', value: text };
  }

  return {
    ok: false,
    reason:
      'expected a domain, public IPv4 address, small netblock or AS number',
  };
}

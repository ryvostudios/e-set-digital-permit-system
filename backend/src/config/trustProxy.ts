import ipaddr from 'ipaddr.js';

/**
 * Express's `trust proxy` setting, when given an address/network list
 * (rather than a boolean or hop count), is compiled by `proxy-addr` -
 * the same module Express uses internally - which recognizes these
 * preset names for common private/loopback ranges alongside literal
 * IPs/CIDRs. Listing them here (rather than requiring an operator to
 * spell out RFC1918 ranges by hand) can never diverge from what Express
 * actually does at runtime with the same string, because it's the exact
 * set proxy-addr itself defines.
 */
const TRUST_PROXY_PRESETS = new Set(['loopback', 'linklocal', 'uniquelocal']);

/** The parsed prefix length that makes a CIDR block match every possible address of its family - "trust everyone", regardless of how the network address portion is spelled. */
const UNIVERSAL_PREFIX_LENGTH = 0;

/** Splits/trims/drops-empties a comma-separated TRUST_PROXY_CIDRS value. Never throws - validity is a separate concern (`isValidTrustProxyToken`). */
export function parseTrustProxyCidrs(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

/**
 * Whether `token` is a safe, specific trusted-proxy entry: one of the
 * presets above, or a single IP address / CIDR block that is NOT a
 * full-range "trust everyone" wildcard. This allowlist has exactly one
 * job - listing specific trusted proxy addresses/networks - so nothing
 * here should ever silently mean "trust everything".
 *
 * A CIDR is rejected by its PARSED prefix length, not by comparing the
 * input text - `ipaddr.parseCIDR` (the same parser Express's own
 * `proxy-addr` uses internally) resolves the network address and mask
 * length independently of how the input was spelled, so every
 * equivalent full-range form is caught uniformly: zero-padded prefixes
 * (`0.0.0.0/00`), a network address with non-zero host bits
 * (`0.0.0.1/0` - the mask alone is what makes this "everyone", the
 * specific address before the slash is irrelevant), and every IPv6
 * spelling of the same thing (`::/0`, `::1/0`, expanded
 * `0:0:0:0:0:0:0:0/0`, etc.) - a prefix length of 0 always means "every
 * address in this family," full stop, regardless of any of that.
 */
export function isValidTrustProxyToken(token: string): boolean {
  if (TRUST_PROXY_PRESETS.has(token)) return true;
  if (token.includes('/')) {
    try {
      const [, prefixLength] = ipaddr.parseCIDR(token);
      return prefixLength > UNIVERSAL_PREFIX_LENGTH;
    } catch {
      return false;
    }
  }
  return ipaddr.isValid(token);
}

/** Every token in `tokens` that fails `isValidTrustProxyToken` - used to build a startup-failing, specific error message rather than a generic "invalid" one. */
export function findInvalidTrustProxyTokens(tokens: readonly string[]): string[] {
  return tokens.filter((token) => !isValidTrustProxyToken(token));
}

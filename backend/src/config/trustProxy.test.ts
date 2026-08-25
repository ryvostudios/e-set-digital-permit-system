import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findInvalidTrustProxyTokens, isValidTrustProxyToken, parseTrustProxyCidrs } from './trustProxy.js';

test('parseTrustProxyCidrs returns [] for undefined/empty input', () => {
  assert.deepEqual(parseTrustProxyCidrs(undefined), []);
  assert.deepEqual(parseTrustProxyCidrs(''), []);
});

test('parseTrustProxyCidrs splits, trims, and drops empty entries', () => {
  assert.deepEqual(parseTrustProxyCidrs('10.0.0.5, 10.0.1.0/24 ,loopback,'), ['10.0.0.5', '10.0.1.0/24', 'loopback']);
});

test('isValidTrustProxyToken accepts the proxy-addr preset names', () => {
  assert.equal(isValidTrustProxyToken('loopback'), true);
  assert.equal(isValidTrustProxyToken('linklocal'), true);
  assert.equal(isValidTrustProxyToken('uniquelocal'), true);
});

test('isValidTrustProxyToken accepts a bare IPv4/IPv6 address', () => {
  assert.equal(isValidTrustProxyToken('10.0.0.5'), true);
  assert.equal(isValidTrustProxyToken('::1'), true);
});

test('isValidTrustProxyToken accepts a well-formed CIDR block', () => {
  assert.equal(isValidTrustProxyToken('10.0.1.0/24'), true);
  assert.equal(isValidTrustProxyToken('fd00::/8'), true);
});

test('isValidTrustProxyToken rejects the literal wildcard "*"', () => {
  assert.equal(isValidTrustProxyToken('*'), false);
});

test('isValidTrustProxyToken rejects a full-range "trust everyone" CIDR', () => {
  assert.equal(isValidTrustProxyToken('0.0.0.0/0'), false);
  assert.equal(isValidTrustProxyToken('::/0'), false);
});

test('isValidTrustProxyToken rejects every equivalent /0 ("trust everyone") representation, by PARSED prefix length - never by string comparison', () => {
  // Canonical forms.
  assert.equal(isValidTrustProxyToken('0.0.0.0/0'), false);
  assert.equal(isValidTrustProxyToken('::/0'), false);
  // Zero-padded prefix length.
  assert.equal(isValidTrustProxyToken('0.0.0.0/00'), false);
  // Non-zero host bits before a /0 mask - the mask alone (not the
  // specific address text) is what makes this "everyone".
  assert.equal(isValidTrustProxyToken('0.0.0.1/0'), false);
  assert.equal(isValidTrustProxyToken('10.20.30.40/0'), false);
  // IPv6 spellings of the same /0 network.
  assert.equal(isValidTrustProxyToken('::1/0'), false);
  assert.equal(isValidTrustProxyToken('0000::/0'), false);
  assert.equal(isValidTrustProxyToken('0:0:0:0:0:0:0:0/0'), false);
  assert.equal(isValidTrustProxyToken('fe80::1/0'), false);
});

test('isValidTrustProxyToken still accepts ordinary, non-/0 CIDRs (the /0 rejection is specific to prefix length 0, not overbroad)', () => {
  assert.equal(isValidTrustProxyToken('0.0.0.0/1'), true);
  assert.equal(isValidTrustProxyToken('128.0.0.0/1'), true);
  assert.equal(isValidTrustProxyToken('10.0.0.0/8'), true);
  assert.equal(isValidTrustProxyToken('192.168.1.0/24'), true);
  assert.equal(isValidTrustProxyToken('::/1'), true);
  assert.equal(isValidTrustProxyToken('fd00::/8'), true);
  assert.equal(isValidTrustProxyToken('2001:db8::/32'), true);
});

test('isValidTrustProxyToken rejects garbage / non-address strings', () => {
  assert.equal(isValidTrustProxyToken('not-an-address'), false);
  assert.equal(isValidTrustProxyToken('true'), false);
  assert.equal(isValidTrustProxyToken(''), false);
});

test('isValidTrustProxyToken rejects a malformed CIDR (invalid prefix length)', () => {
  assert.equal(isValidTrustProxyToken('10.0.0.0/99'), false);
  assert.equal(isValidTrustProxyToken('10.0.0.0/-1'), false);
});

test('findInvalidTrustProxyTokens returns exactly the offending entries, preserving order', () => {
  const result = findInvalidTrustProxyTokens(['10.0.0.5', 'garbage', 'loopback', '*', '0.0.0.0/0']);
  assert.deepEqual(result, ['garbage', '*', '0.0.0.0/0']);
});

test('findInvalidTrustProxyTokens returns [] when every entry is valid', () => {
  assert.deepEqual(findInvalidTrustProxyTokens(['10.0.0.5', 'loopback', '10.0.1.0/24']), []);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  COMPANY_CODE_ATTEMPTS,
  companyCodeCandidate,
  isUniqueViolation,
  normalizeCompanyCode,
  uniqueViolationTarget,
} from './organizationCodes.js';

/**
 * Company code generation. What matters is not the exact string but the
 * guarantees: a code is derived on the server from a display name, it
 * always satisfies the format migration 0035 enforces, collisions
 * produce a DIFFERENT candidate rather than a duplicate, and nothing a
 * client sends can steer it.
 */

/** The format `companies_code_format` enforces in the database. */
const CODE_FORMAT = /^[A-Z][A-Z0-9_]*$/;

test('a display name becomes a readable machine code', () => {
  assert.equal(normalizeCompanyCode('ABC Contractors'), 'ABC_CONTRACTORS');
  assert.equal(normalizeCompanyCode('XYZ Services'), 'XYZ_SERVICES');
  assert.equal(normalizeCompanyCode('  acme-services  '), 'ACME_SERVICES');
  assert.equal(normalizeCompanyCode('Hughes & Sons, Ltd.'), 'HUGHES_SONS_LTD');
});

test('an accented name folds to its base letters rather than being emptied', () => {
  // NFKD splits the letter from its mark, and the mark is then removed by
  // the same pass that handles spaces and punctuation.
  const code = normalizeCompanyCode('Ökosan Energi');
  assert.match(code, CODE_FORMAT);
  assert.ok(code.includes('KOSAN'), `expected the base letters to survive, got "${code}"`);
  assert.ok(code.includes('ENERGI'));
});

test('the seeded codes are exactly what their names already normalize to', () => {
  // Proof the generator agrees with history rather than contradicting it:
  // nothing regenerates or rewrites E_SET / ZPL / SGRE, and this would
  // catch a generator that drifted away from the shape they use.
  assert.equal(normalizeCompanyCode('ZPL'), 'ZPL');
  assert.equal(normalizeCompanyCode('SGRE'), 'SGRE');
  assert.equal(normalizeCompanyCode('E-SET'), 'E_SET');
});

test('every generated code satisfies the database format constraint', () => {
  const names = [
    'ABC Contractors',
    '3M Solutions',
    '  ',
    '!!!',
    '   ---   ',
    '7',
    'a',
    'Very Long Company Name That Goes On And On And On And On And On Forever',
  ];
  for (const name of names) {
    for (const attempt of [0, 1, 2, 9, COMPANY_CODE_ATTEMPTS - 1]) {
      const code = companyCodeCandidate(name, attempt);
      assert.match(code, CODE_FORMAT, `"${name}" attempt ${attempt} produced "${code}"`);
      assert.ok(code.length <= 48, `"${code}" is too long`);
    }
  }
});

test('a name that cannot yield letters still produces a valid code', () => {
  assert.equal(companyCodeCandidate('!!!', 0), 'COMPANY');
  assert.match(companyCodeCandidate('!!!', 1), CODE_FORMAT);
});

test('a name starting with a digit is prefixed, never rejected', () => {
  const code = normalizeCompanyCode('3M Solutions');
  assert.match(code, CODE_FORMAT);
  assert.ok(code.includes('3M_SOLUTIONS'));
});

test('each attempt yields a DIFFERENT candidate, so a retry can succeed', () => {
  const seen = new Set<string>();
  for (let attempt = 0; attempt < COMPANY_CODE_ATTEMPTS; attempt += 1) {
    seen.add(companyCodeCandidate('ABC Contractors', attempt));
  }
  assert.equal(seen.size, COMPANY_CODE_ATTEMPTS, 'two attempts produced the same code');
  assert.equal(companyCodeCandidate('ABC Contractors', 0), 'ABC_CONTRACTORS');
  assert.equal(companyCodeCandidate('ABC Contractors', 1), 'ABC_CONTRACTORS_2');
  assert.equal(companyCodeCandidate('ABC Contractors', 2), 'ABC_CONTRACTORS_3');
});

test('a long name keeps its uniqueness suffix - the BASE is trimmed, never the suffix', () => {
  const long = 'A'.repeat(80);
  const first = companyCodeCandidate(long, 0);
  const second = companyCodeCandidate(long, 1);
  assert.notEqual(first, second, 'the suffix was trimmed away, reintroducing a collision');
  assert.ok(second.endsWith('_2'));
  assert.ok(second.length <= 48);
});

test('generation is deterministic for a given name and attempt', () => {
  assert.equal(
    companyCodeCandidate('ABC Contractors', 3),
    companyCodeCandidate('ABC Contractors', 3),
  );
});

test('a unique violation is recognised, and its constraint identified', () => {
  const nameClash = Object.assign(new Error('duplicate key'), {
    code: '23505',
    constraint: 'companies_name_normalized_unique',
  });
  const codeClash = Object.assign(new Error('duplicate key'), {
    code: '23505',
    constraint: 'companies_code_key',
  });

  assert.equal(isUniqueViolation(nameClash), true);
  assert.equal(uniqueViolationTarget(nameClash), 'companies_name_normalized_unique');
  assert.equal(uniqueViolationTarget(codeClash), 'companies_code_key');

  // A duplicate NAME and a duplicate generated CODE both arrive as
  // 23505; telling them apart is what lets one be reported to the
  // administrator and the other retried silently.
  assert.notEqual(uniqueViolationTarget(nameClash), uniqueViolationTarget(codeClash));
});

test('an unrelated database error is never mistaken for a collision', () => {
  assert.equal(isUniqueViolation(new Error('connection reset')), false);
  assert.equal(isUniqueViolation({ code: '23503' }), false);
  assert.equal(isUniqueViolation(null), false);
  assert.equal(uniqueViolationTarget(new Error('connection reset')), null);
});

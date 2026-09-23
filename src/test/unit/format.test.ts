import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeHexBytes, formatNumber, normalizeFormat } from '../../format';
import { parseSymbolCsv } from '../../parse';
import { TableView, symbolTable } from '../../table';

const g = (precision: number | 'full', squeeze = true) => ({ style: 'g' as const, precision, squeeze });
const f = (precision: number, squeeze = false) => ({ style: 'f' as const, precision, squeeze });
const e = (precision: number | 'full', squeeze = false) => ({ style: 'e' as const, precision, squeeze });

describe('formatNumber', () => {
  it('g-format behaves like %g', () => {
    assert.equal(formatNumber('373.533333203333', g(6)), '373.533');
    assert.equal(formatNumber('1234567', g(6)), '1.23457E+06');
    assert.equal(formatNumber('0.0001', g(6)), '0.0001');
    assert.equal(formatNumber('0.00001234', g(6)), '1.234E-05');
    assert.equal(formatNumber('350', g(2)), '3.5E+02');
    assert.equal(formatNumber('0.5', g(6, false)), '0.500000');
    assert.equal(formatNumber('0', g(6)), '0');
    assert.equal(formatNumber('-0.000000001', g(3)), '-1E-09');
  });

  it('full precision shows the shortest exact representation', () => {
    assert.equal(formatNumber('0.009000000000000001', g('full')), '0.009000000000000001');
    assert.equal(formatNumber('350', g('full')), '350');
    assert.equal(formatNumber('3.141592653589793', g('full')), '3.141592653589793');
    assert.equal(formatNumber('1e-12', g('full')), '1E-12');
    assert.equal(formatNumber('1.5e+30', g('full')), '1.5E+30');
    assert.equal(formatNumber('123456789012345', g('full')), '123456789012345');
    assert.equal(formatNumber('1234567890123456', g('full')), '1.234567890123456E+15');
    assert.equal(formatNumber('1.5e+30', e('full')), '1.5E+30');
  });

  it('f-format uses a fixed number of decimals', () => {
    assert.equal(formatNumber('373.533333203333', f(2)), '373.53');
    assert.equal(formatNumber('2', f(3)), '2.000');
    assert.equal(formatNumber('2.5', f(3, true)), '2.5');
    assert.equal(formatNumber('-0.001', f(2)), '0.00');
    assert.equal(formatNumber('1.5e+30', f(2)), '1.5E+30');
    assert.equal(formatNumber('0.5', f(0)), '1');
  });

  it('e-format uses scientific notation', () => {
    assert.equal(formatNumber('373.533333203333', e(4)), '3.735E+02');
    assert.equal(formatNumber('0.5', e(3)), '5.00E-01');
    assert.equal(formatNumber('0.5', e(3, true)), '5E-01');
  });

  it('leaves special values, text and empty cells alone', () => {
    for (const v of ['Eps', 'NA', '+Inf', '-Inf', 'Undf', '', 'hello']) {
      assert.equal(formatNumber(v, g(3)), v);
    }
  });
});

describe('normalizeFormat', () => {
  it('clamps precisions per style and fills in defaults', () => {
    assert.deepEqual(normalizeFormat({ style: 'f', precision: 20 }), { style: 'f', precision: 14, squeeze: true });
    assert.deepEqual(normalizeFormat({ style: 'f', precision: 'full' }), { style: 'f', precision: 6, squeeze: true });
    assert.deepEqual(normalizeFormat({ style: 'e', precision: 0, squeeze: false }), { style: 'e', precision: 1, squeeze: false });
    assert.deepEqual(normalizeFormat({ style: 'x' as never }), { style: 'g', precision: 6, squeeze: true });
  });
});

describe('decodeHexBytes', () => {
  it('decodes IEEE 754 bits written by gdxdump dFormat=hexBytes', () => {
    assert.equal(decodeHexBytes('0x4049000000000000'), '50');
    // gdxdump's default output rounds this to 0.00900000000000001.
    assert.equal(decodeHexBytes('0x3f826e978d4fdf40'), '0.009000000000000008');
    assert.equal(decodeHexBytes('0xc202a05f20000000'), '-10000000000');
    assert.equal(decodeHexBytes('0x8000000000000000'), '0');
    assert.equal(decodeHexBytes('Eps'), 'Eps');
  });

  it('is applied to value columns (not keys or texts) when parsing CSV', () => {
    const data = parseSymbolCsv('"i","Val","Marginal"\n"0x4049000000000000",0x4049000000000000,Eps\n', { dim: 1, type: 'Var', domain: ['i'] });
    assert.deepEqual(data.rows[0], ['0x4049000000000000', '50', 'Eps']);
  });
});

describe('formatted pages', () => {
  const view = new TableView(symbolTable({ columns: ['i', 'j', 'Value'], keyCount: 2, rows: [['a', 'x', '0.009000000000000001'], ['a', 'y', '2']] }));

  it('formats list pages and keeps the exact values', () => {
    const p = view.query({ pageSize: 10, format: g(3) });
    assert.deepEqual(p.rows[0].cells, ['a', 'x', '0.009']);
    assert.deepEqual(p.rows[0].exact, ['a', 'x', '0.009000000000000001']);
    assert.equal(p.rows[1].exact, undefined);
    assert.deepEqual(view.query({ pageSize: 10 }).rows[0].cells, ['a', 'x', '0.009000000000000001']);
  });

  it('formats pivot pages; copying keeps exact values', () => {
    const p = view.pivot({ pageSize: 10, colPageSize: 10, format: f(1) });
    assert.deepEqual(p.rows[0].cells, ['0.0', '2.0']);
    assert.deepEqual(p.rows[0].exact, ['0.009000000000000001', '2']);
    assert.match(view.pivotTsv({}), /0\.009000000000000001\t2/);
  });
});

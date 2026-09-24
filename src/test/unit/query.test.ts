import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_FORMAT } from '../../format';
import { answerQuery, copyText } from '../../query';
import { TableView, symbolTable } from '../../table';

const settings = { pageSize: 2, colPageSize: 2, defaultFormat: DEFAULT_FORMAT };

function view() {
  return new TableView(
    symbolTable({
      columns: ['r', 't', 'Value'],
      keyCount: 2,
      rows: [
        ['north', 'jan', '1'],
        ['north', 'feb', '2'],
        ['north', 'mar', '3'],
        ['south', 'jan', '4'],
        ['south', 'feb', '5'],
        ['south', 'mar', '6'],
      ],
    }),
  );
}

describe('answerQuery search', () => {
  it('highlights matches without filtering and reports those on the page', () => {
    const a = answerQuery(view(), { search: { text: 'feb' } }, settings);
    assert.equal(a.filteredCount, 6);
    assert.equal(a.search?.count, 2);
    assert.deepEqual(a.search?.hits, [{ r: 1, c: 1 }]);
    assert.equal(a.search?.current, undefined);
  });

  it('moves to the page of a match and wraps around', () => {
    const a = answerQuery(view(), { search: { text: 'feb' }, findIndex: 1 }, settings);
    assert.equal(a.page, 2);
    assert.deepEqual(a.search?.current, { index: 1, hit: { r: 4, c: 1 } });
    assert.deepEqual(a.search?.hits, [{ r: 4, c: 1 }]);
    const wrapped = answerQuery(view(), { search: { text: 'feb' }, findIndex: -1 }, settings);
    assert.equal(wrapped.search?.current?.index, 1);
    assert.equal(answerQuery(view(), { search: { text: 'feb' }, findIndex: 2 }, settings).search?.current?.index, 0);
  });

  it('moves to the row and column page of a match in the table view', () => {
    const a = answerQuery(view(), { view: 'table', search: { text: '6', exact: true }, findIndex: 0 }, settings);
    assert.equal(a.kind, 'pivot');
    if (a.kind === 'pivot') {
      assert.equal(a.page, 0);
      assert.equal(a.colPage, 1);
      assert.deepEqual(a.search?.hits, [{ r: 1, c: 2 }]);
    }
  });

  it('filters rows in filter mode and reports invalid expressions', () => {
    const a = answerQuery(view(), { search: { text: 'south', filterRows: true } }, settings);
    assert.equal(a.filteredCount, 3);
    assert.equal(a.search?.count, 0);
    const bad = answerQuery(view(), { search: { text: '(', regex: true, filterRows: true } }, settings);
    assert.equal(bad.filteredCount, 6);
    assert.ok(bad.search?.error);
    assert.ok(answerQuery(view(), { search: { text: '(', regex: true } }, settings).search?.error);
  });

  it('still accepts the text filter of older webviews', () => {
    assert.equal(answerQuery(view(), { filter: 'jan' }, settings).filteredCount, 2);
  });
});

describe('copyText', () => {
  it('copies the rows of the filter mode but ignores highlighting', () => {
    const req = { type: 'copy' as const, name: 'x', selection: { all: true }, separator: 'tab' as const, labels: true };
    const filtered = copyText(view(), { ...req, query: { search: { text: 'south', filterRows: true } } }, DEFAULT_FORMAT, '.');
    assert.equal(filtered.text.trim().split('\n').length, 4);
    const highlighted = copyText(view(), { ...req, query: { search: { text: 'south' } } }, DEFAULT_FORMAT, '.');
    assert.equal(highlighted.text.trim().split('\n').length, 7);
  });
});

describe('windows of rows (continuous scrolling)', () => {
  const rows = Array.from({ length: 1000 }, (_, k) => [`r${k}`, `c${k % 3}`, String(k)]);
  const view = () => new TableView(symbolTable({ columns: ['r', 'c', 'Value'], keyCount: 2, rows }));
  const settings = { pageSize: 100, colPageSize: 10, defaultFormat: DEFAULT_FORMAT };

  it('returns the rows from an offset, clamped to the rows, and echoes the sequence number', () => {
    const a = answerQuery(view(), { offset: 250, seq: 7 }, settings);
    assert.equal(a.kind, 'list');
    assert.equal(a.seq, 7);
    assert.equal(a.kind === 'list' && a.offset, 250);
    assert.equal(a.kind === 'list' && a.rows[0].cells[0], 'r250');
    const end = answerQuery(view(), { offset: 5000 }, settings);
    assert.equal(end.kind === 'list' && end.offset, 999);
  });

  it('windows the rows of the table view', () => {
    const a = answerQuery(view(), { view: 'table', rowDims: [0], colDims: [1], offset: 120 }, settings);
    assert.equal(a.kind, 'pivot');
    assert.equal(a.kind === 'pivot' && a.offset, 120);
    assert.equal(a.kind === 'pivot' && a.rows[0].labels[0], 'r120');
  });

  it('moves the window to a match outside of it, and keeps it for a match inside', () => {
    const far = answerQuery(view(), { offset: 0, search: { text: 'r777', exact: true }, findIndex: 0 }, settings);
    assert.equal(far.kind === 'list' && far.offset, 777 - 25);
    const near = answerQuery(view(), { offset: 0, search: { text: 'r42', exact: true }, findIndex: 0 }, settings);
    assert.equal(near.kind === 'list' && near.offset, 0);
  });
});

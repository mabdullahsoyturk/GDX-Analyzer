import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_FORMAT } from '../../format';
import type { GdxSymbol } from '../../parse';
import { MAX_PREVIEW_RECORDS, PREVIEW_ROWS, escapeMarkdown, filePreview, symbolPreview } from '../../preview';
import { TableView, symbolTable } from '../../table';

const FIELDS = ['Level', 'Marginal', 'Lower', 'Upper', 'Scale'];

function sym(s: Partial<GdxSymbol> & Pick<GdxSymbol, 'name' | 'type' | 'dim'>): GdxSymbol {
  return { records: 0, text: '', domain: Array(s.dim).fill('*'), ...s };
}

describe('hover previews', () => {
  it('shows a variable: its first records, the fields that are not defaults, and its solution status', () => {
    const rows = [
      ['i1', '5', '0', '0', '20', '1'],
      ['i2', '0', '2', '0', '20', '1'],
      ['i3', '-0.5', '0', '0', '20', '1'],
    ];
    const symbol = sym({ name: 'x', type: 'Var', subtype: 'positive', dim: 1, domain: ['i'], records: 3, text: 'flows' });
    const view = new TableView(symbolTable({ columns: ['i', ...FIELDS], keyCount: 1, rows }, symbol));
    assert.equal(
      symbolPreview(symbol, 'out.gdx', view, DEFAULT_FORMAT, '[Show](command:show)'),
      [
        '**x(i)** · Positive Variable · 3 records · `out.gdx` · [Show](command:show)',
        'flows',
        'Solution: **1 record outside bounds** · 1 non-zero marginal · 1 at lower bound · 0 at upper bound',
        '| i | Level | Marginal | Upper |\n|:--|--:|--:|--:|\n| i1 | 5 | 0 | 20 |\n| i2 | 0 | 2 | 20 |\n| i3 | -0.5 | 0 | 20 |',
        'Default in every record: Lower = 0, Scale = 1',
      ].join('\n\n'),
    );
  });

  it('summarizes the values of symbols with more records than shown', () => {
    const rows = Array.from({ length: 20 }, (_, k) => [`a${k}`, String(k)]);
    rows.push(['eps', 'Eps']);
    const symbol = sym({ name: 'p', type: 'Par', dim: 1, records: rows.length });
    const text = symbolPreview(symbol, 'd.gdx', new TableView(symbolTable({ columns: ['Dim1', 'Value'], keyCount: 1, rows }, symbol)), DEFAULT_FORMAT);
    assert.equal(text.split('\n').filter((l) => /^\| a/.test(l)).length, PREVIEW_ROWS);
    assert.match(text, /First 5 of 21 records/);
    assert.match(text, /Value: min 0 · max 19 · sum 190 · 1 Eps/);
    assert.doesNotMatch(text, /Solution:/);
  });

  it('shows scalars on one line and leaves out set texts when no element has one', () => {
    const z = sym({ name: 'z', type: 'Var', subtype: 'free', dim: 0, records: 1 });
    const zView = new TableView(symbolTable({ columns: FIELDS, keyCount: 0, rows: [['42', '0', '-Inf', '+Inf', '1']] }, z));
    assert.match(symbolPreview(z, 'out.gdx', zView, DEFAULT_FORMAT), /\n\nLevel = 42\n\n/);
    const j = sym({ name: 'j', type: 'Set', dim: 1, records: 2 });
    const jView = new TableView({ ...symbolTable({ columns: ['Dim1', 'Text'], keyCount: 1, rows: [['a', ''], ['b', '']] }, j), setTexts: false });
    assert.match(symbolPreview(j, 'out.gdx', jView, DEFAULT_FORMAT), /\| Dim1 \|\n\|:--\|\n\| a \|\n\| b \|$/);
  });

  it('escapes Markdown in labels and texts', () => {
    assert.equal(escapeMarkdown('a|b *c* [d] <e> `f` _g_'), 'a\\|b \\*c\\* \\[d\\] \\<e\\> \\`f\\` \\_g\\_');
    const symbol = sym({ name: 'k', type: 'Set', dim: 1, records: 1, text: 'a | b' });
    const view = new TableView({ ...symbolTable({ columns: ['Dim1', 'Text'], keyCount: 1, rows: [['x|y', 'has *stars*']] }, symbol), setTexts: false });
    const text = symbolPreview(symbol, 'e.gdx', view, DEFAULT_FORMAT);
    assert.match(text, /\n\na \\\| b\n\n/);
    assert.match(text, /\| x\\\|y \| has \\\*stars\\\* \|/);
  });

  it('does not read symbols with too many records', () => {
    const big = sym({ name: 'big', type: 'Par', dim: 2, records: MAX_PREVIEW_RECORDS + 1 });
    assert.match(symbolPreview(big, 'big.gdx', undefined, DEFAULT_FORMAT), /^\*\*big\(\\\*,\\\*\)\*\* · Parameter · 200,001 records · `big\.gdx`\n\nToo many records to preview here/);
  });

  it('shows the symbols of a file by type', () => {
    const info = {
      version: [
        ['Unique Elements', '9'],
        ['Producer', 'GAMS Base Module 54.2.2'],
      ] as [string, string][],
      symbols: [sym({ name: 'i', type: 'Set', dim: 1 }), sym({ name: 'ii', type: 'Alias', dim: 1 }), sym({ name: 'x', type: 'Var', dim: 1 }), sym({ name: 'y', type: 'Var', dim: 1 })],
    };
    assert.equal(filePreview('t.gdx', info), '**t.gdx** · 4 symbols: 1 set, 1 alias, 2 variables\n\n9 unique elements · written by GAMS Base Module 54.2.2');
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GdxReferences, gamsReferences, pythonReferences } from '../../gdxRefs';

/** The references as [text at the offsets, file] and [name, file] (checking that the offsets cover the name). */
function shown(text: string, refs: GdxReferences) {
  return {
    files: refs.files.map((r) => [text.slice(r.start, r.end), r.file]),
    symbols: refs.symbols.map((r) => {
      assert.equal(text.slice(r.start, r.end), r.name);
      return [r.name, r.file];
    }),
  };
}

describe('GDX references in GAMS source', () => {
  it('links $gdxIn files, with .gdx added, and the symbols of $load', () => {
    const text = ['Set i, j;', '$gdxIn mydata', '$load i j=markets', '$loadDC a, b=demand', '$gdxIn', '$load x', "$gdxIn 'my data/trnsport.gdx'", '$load c'].join('\n');
    assert.deepEqual(shown(text, gamsReferences(text)), {
      files: [
        ['mydata', 'mydata.gdx'],
        ['my data/trnsport.gdx', 'my data/trnsport.gdx'],
      ],
      symbols: [
        ['i', 'mydata.gdx'],
        ['markets', 'mydata.gdx'],
        ['a', 'mydata.gdx'],
        ['demand', 'mydata.gdx'],
        ['c', 'my data/trnsport.gdx'],
      ],
    });
  });

  it('links projections, $gdxLoad, $gdxUnload and $unLoad after $gdxOut', () => {
    const text = ['$gdxIn data', '$load i<adata.dim2 j<=d k<e', '$gdxLoad other.gdx p q=r', '$gdxLoadAll all', '$gdxOut out', '$unLoad a b=c', '$gdxUnload B.gdx d'].join('\r\n');
    assert.deepEqual(shown(text, gamsReferences(text)), {
      files: [
        ['data', 'data.gdx'],
        ['other.gdx', 'other.gdx'],
        ['all', 'all.gdx'],
        ['out', 'out.gdx'],
        ['B.gdx', 'B.gdx'],
      ],
      symbols: [
        ['adata', 'data.gdx'],
        ['d', 'data.gdx'],
        ['e', 'data.gdx'],
        ['p', 'other.gdx'],
        ['r', 'other.gdx'],
        ['a', 'out.gdx'],
        ['c', 'out.gdx'],
        ['d', 'B.gdx'],
      ],
    });
  });

  it('links execute_load and execute_unload statements over several lines, but not those without a file name', () => {
    const text = ["execute_unload 'results.gdx', x, supply,", '               demand=dem;', 'execute_loadpoint "start";', "EXECUTE_LOADDC 'data', i=*;", "put_utility 'gdxIn' / s.tl:0 '.gdx';", 'execute_load objval = wnx;', 'display x;'].join('\n');
    assert.deepEqual(shown(text, gamsReferences(text)), {
      files: [
        ['results.gdx', 'results.gdx'],
        ['start', 'start.gdx'],
        ['data', 'data.gdx'],
      ],
      symbols: [
        ['x', 'results.gdx'],
        ['supply', 'results.gdx'],
        ['dem', 'results.gdx'],
        ['*', 'data.gdx'],
      ],
    });
  });

  it('skips comments, compile-time variables and wildcards, but links other .gdx names', () => {
    const text = [
      '* execute_load "commented.gdx", a;',
      '$onText',
      '$gdxIn intext',
      '$offText',
      "execute_unload '%outdir%res.gdx', x;",
      '$call gams trnsport gdx=out.gdx lo=2',
      "put_utility 'gdxout' / 'put.gdx';",
      '$call gdxdump C:\\data\\run.gdx',
      "execute 'mv -f bchout_i.gdx lastsol.gdx';",
      "$call 'gdxdump bchdicut*.gdx'",
    ].join('\n');
    assert.deepEqual(shown(text, gamsReferences(text)), {
      // Names ending in .gdx are linked even in comments; statements in comments are not parsed.
      files: [
        ['commented.gdx', 'commented.gdx'],
        ['out.gdx', 'out.gdx'],
        ['put.gdx', 'put.gdx'],
        ['C:\\data\\run.gdx', 'C:\\data\\run.gdx'],
        ['bchout_i.gdx', 'bchout_i.gdx'],
        ['lastsol.gdx', 'lastsol.gdx'],
      ],
      symbols: [],
    });
  });

  it('does not link the same name twice', () => {
    const text = "$gdxIn 'a.gdx'\nexecute_load \"b.gdx\", x;";
    assert.deepEqual(shown(text, gamsReferences(text)).files, [
      ['a.gdx', 'a.gdx'],
      ['b.gdx', 'b.gdx'],
    ]);
  });
});

describe('GDX references in Python source', () => {
  it('links string literals ending in .gdx', () => {
    const text = ['m = Container(load_from="data/in.gdx")', "m.write('out.GDX')", 'c = gt.Container(f"{run}.gdx")', 'name = "notes.txt"'].join('\n');
    assert.deepEqual(shown(text, pythonReferences(text)), {
      files: [
        ['data/in.gdx', 'data/in.gdx'],
        ['out.GDX', 'out.GDX'],
      ],
      symbols: [],
    });
  });
});

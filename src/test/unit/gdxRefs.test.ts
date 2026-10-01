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

describe('GDX symbols in GAMSPy and GAMS Transfer code', () => {
  it('finds the symbols read and written with symbol_names=, symbols= or a list after the file', () => {
    const text = [
      'm.write("results.gdx", symbol_names=["x", "z"])',
      "c.read('in.gdx', symbols='a')",
      'm.loadRecordsFromGdx(load_from="in.gdx", symbol_names=("d", "f"))',
      'c.write("out.gdx", ["cost"])',
      'm.read("in.gdx", symbol_names=names)',
      'f.read()',
    ].join('\n');
    assert.deepEqual(shown(text, pythonReferences(text)).symbols, [
      ['x', 'results.gdx'],
      ['z', 'results.gdx'],
      ['a', 'in.gdx'],
      ['d', 'in.gdx'],
      ['f', 'in.gdx'],
      ['cost', 'out.gdx'],
    ]);
  });

  it('finds m["x"] of a container read from a file, with the file it was last read from', () => {
    const text = [
      'import gamspy as gp',
      'm = gp.Container(load_from="base.gdx")',
      'x = m["x"]',
      'c = gt.Container("t.gdx")',
      "a = c['a']",
      'other["y"]',
      'm.read("run2.gdx")',
      'price = m["p"]',
    ].join('\n');
    assert.deepEqual(shown(text, pythonReferences(text)).symbols, [
      ['x', 'base.gdx'],
      ['a', 't.gdx'],
      ['p', 'run2.gdx'],
    ]);
  });

  it('binds Python names to symbols of other names', () => {
    const text = [
      'm = Container(load_from="in.gdx")',
      'limit = gp.Equation(m, name="supply", domain=i)',
      'cost = Equation(m, "costDef")',
      'x = Variable(m, "x")',
      '    price = m["p"]',
      'i, j = m["i"], m["j"]',
      'dem = c.addParameter("demand", ["j"])',
      'Model(m, objective=Sum(x, c), sense=Sense.MIN, problem = Equation(m, "nope"))',
    ].join('\n');
    const names = pythonReferences(text).names!;
    for (const n of names) assert.equal(text.slice(n.start, n.end), n.name);
    assert.deepEqual(
      names.map((n) => [n.name, n.symbol]),
      [
        ['limit', 'supply'],
        ['cost', 'costDef'],
        ['price', 'p'],
        ['dem', 'demand'],
      ],
    );
  });

  it('binds the names of symbols added with the add methods of a container', () => {
    const text = [
      'plants = c.addSet("i", records=["seattle", "san-diego"])',
      'markets = m.addAlias("jj", j)',
      'everything = c.addUniverseAlias("u")',
      'cap = c.addParameter(name="a", domain=plants)',
      'ship = m.addVariable("x", "positive", [plants, markets])',
      'demand_eq = m.addEquation("demand", "geq", domain=markets)',
      'every = UniverseAlias(m, "uu")',
      'z = m.addVariable("z")',
    ].join('\n');
    assert.deepEqual(
      pythonReferences(text).names!.map((n) => [text.slice(n.start, n.end), n.symbol]),
      [
        ['plants', 'i'],
        ['markets', 'jj'],
        ['everything', 'u'],
        ['cap', 'a'],
        ['ship', 'x'],
        ['demand_eq', 'demand'],
        ['every', 'uu'],
      ],
    );
  });
});

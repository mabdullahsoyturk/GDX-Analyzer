/*
 * The GDX queries for AI agents (gdxQuery.ts) and the MCP server (mcp.ts) against the
 * fixtures. Skipped if no GAMS system is found (see tools.test.ts for GDX_TEST_GAMS_DIR).
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { after, describe, it } from 'node:test';
import { GdxQueries, QueryError, TOOL_SPECS } from '../../gdxQuery';
import { McpServer } from '../../mcp';
import { GdxTools, ResolvedTools, resolveTools } from '../../tools';

const fixtures = path.resolve(__dirname, '../../../test/fixtures');

function tryResolve(): ResolvedTools | undefined {
  try {
    return resolveTools({ backend: 'gams', gamsSystemDirectory: process.env.GDX_TEST_GAMS_DIR });
  } catch {
    return undefined;
  }
}

const resolved = tryResolve();

describe('GDX queries for agents', { skip: resolved ? false : 'GAMS tools not found' }, () => {
  const queries = new GdxQueries({ encoding: 'utf-8', tools: () => new GdxTools(resolved!) }, fixtures);
  after(() => queries.dispose());

  it('lists symbols with types and domains, relative to the working directory', async () => {
    const text = await queries.call('gdx_list_symbols', { file: 'transport1.gdx', type: 'Variable' });
    assert.match(text, /14 symbols, 9 unique elements/);
    assert.match(text, /^x,Positive Variable,2,"i,j",6,shipment quantities in cases$/m);
    assert.match(text, /^z,Free Variable,0,,1,/m);
    assert.doesNotMatch(text, /^a,/m);
  });

  it('reads records with case-insensitive filters and leaves out default fields', async () => {
    const text = await queries.call('gdx_read_symbol', {
      file: 'transport1.gdx',
      symbol: 'X',
      filters: { 1: ['SEATTLE'], L: { min: 0, max: 0, exclude: true } },
      sortBy: 'Level',
      descending: true,
    });
    assert.match(text, /Rows 1-2 of 2 matching records \(6 in total\)/);
    assert.match(text, /Left out \(default value in every record\): Lower=0, Upper=\+Inf, Scale=1/);
    assert.match(text, /i,j,Level,Marginal\nseattle,chicago,300,0\nseattle,new-york,50,0$/);
  });

  it('pages, selects fields and reads exact values and special values', async () => {
    const page = await queries.call('gdx_read_symbol', { file: 'transport1.gdx', symbol: 'x', fields: ['Marginal'], limit: 2, page: 2 });
    assert.match(page, /Rows 5-6 of 6 records\ni,j,Marginal\nsan-diego,chicago,0\.009000000000000008\n/);
    assert.doesNotMatch(page, /more: page/);
    const specials = await queries.call('gdx_read_symbol', { file: 'transport1.gdx', symbol: 'specials' });
    assert.match(specials, /Eps\n.*NA\n.*\+Inf\n.*-Inf$/);
  });

  it('reads the universe and set texts without "Y"', async () => {
    assert.match(await queries.call('gdx_read_symbol', { file: 'transport1.gdx', symbol: '*', limit: 2 }), /Label,UEL #\nseattle,1\nsan-diego,2\n\(more: page=1\)/);
    assert.match(await queries.call('gdx_read_symbol', { file: 'edge.gdx', symbol: 'k' }), /"a,b","has, comma"\nit's,single quote\n"x""y",dq label\nsüß,"ümlaut ""text"""$/);
    assert.match(await queries.call('gdx_read_symbol', { file: 'transport1.gdx', symbol: 'j' }), /Dim1,Text\nnew-york,\nchicago,\ntopeka,$/);
  });

  it('summarizes records', async () => {
    const text = await queries.call('gdx_symbol_stats', { file: 'transport1.gdx', symbol: 'x', filters: { i: ['seattle'] } });
    assert.match(text, /3 records match \(6 in total\)/);
    assert.match(text, /^j,3,new-york \| chicago \| topeka$/m);
    assert.match(text, /^Level,3,350,116\.66666666666667,0,300,1,$/m);
    assert.match(text, /^Upper,0,,,,,0,\+Inf: 3$/m);
  });

  it('filters variables and equations by solution status', async () => {
    const binding = await queries.call('gdx_read_symbol', { file: 'transport1.gdx', symbol: 'supply', solution: 'marginal' });
    assert.match(binding, /Rows 1-1 of 1 matching record \(2 in total\)/);
    assert.match(binding, /i,Level,Marginal,Upper\nseattle,350,Eps,350$/);
    const atLower = await queries.call('gdx_symbol_stats', { file: 'transport1.gdx', symbol: 'x', solution: 'atLower' });
    assert.match(atLower, /2 records match \(6 in total\)/);
    await assert.rejects(queries.call('gdx_read_symbol', { file: 'transport1.gdx', symbol: 'a', solution: 'marginal' }), /applies only to variables and equations/);
    await assert.rejects(queries.call('gdx_read_symbol', { file: 'transport1.gdx', symbol: 'x', solution: 'binding' }), /Invalid "solution"/);
  });

  it('compares files and shows the differing records of a symbol', async () => {
    const summary = await queries.call('gdx_compare', { file1: 'transport1.gdx', file2: 'transport2.gdx' });
    assert.match(summary, /5 symbols differ/);
    assert.match(summary, /^extra,Parameter,0,Symbol not found in file 1$/m);
    const x = await queries.call('gdx_compare', { file1: 'transport1.gdx', file2: 'transport2.gdx', symbol: 'x' });
    assert.match(x, /i,j,Status,Level \(file 1\),Level \(file 2\),Δ Level,Δ% Level\nseattle,new-york,changed,50,60,10,20\n/);
    assert.match(await queries.call('gdx_compare', { file1: 'transport1.gdx', file2: 'transport2.gdx', symbol: 'b' }), /b does not differ/);
    // The largest relative change first (+20% beats -3.6%), unlike the signed ascending order.
    const byMagnitude = await queries.call('gdx_compare', { file1: 'transport1.gdx', file2: 'transport2.gdx', symbol: 'x', sortBy: 'Δ% Level', byMagnitude: true, descending: true });
    assert.match(byMagnitude, /Δ% Level\nseattle,new-york,changed,50,60,10,20\nsan-diego,new-york,changed,275,265,-10,-3\.63/);
    const ascending = await queries.call('gdx_compare', { file1: 'transport1.gdx', file2: 'transport2.gdx', symbol: 'x', sortBy: 'Δ% Level' });
    assert.match(ascending, /Δ% Level\nsan-diego,new-york/);
    assert.match(await queries.call('gdx_compare', { file1: 'transport1.gdx', file2: 'transport1.gdx' }), /no differences/);
  });

  it('compares scenarios: the symbols of the files, and a symbol with Δ and Δ% from the base', async () => {
    const files = ['transport1.gdx', 'transport2.gdx'];
    const list = await queries.call('gdx_compare_scenarios', { files });
    assert.match(list, /^Scenarios \(base: transport1\): transport1 = .*transport1\.gdx; transport2 = .*transport2\.gdx$/m);
    assert.match(list, /^name,type,dim,domain,text,transport1,transport2$/m);
    assert.match(list, /^x,Positive Variable,2,"i,j",shipment quantities in cases,6,6$/m);
    assert.match(list, /^extra,Parameter,0,,.*,,1$/m);

    const x = await queries.call('gdx_compare_scenarios', { files, symbol: 'x', fields: ['Level', 'Δ Level', 'Δ% Level'], sortBy: 'Δ% Level', byMagnitude: true, descending: true, limit: 2 });
    assert.match(x, /Rows 1-2 of 12 rows/);
    assert.match(x, /i,j,Scenario,Level,Δ Level,Δ% Level\nseattle,new-york,transport2,60,10,20\nsan-diego,new-york,transport2,265,-10,-3\.63/);
    // Another base, by name; a filter on the scenario.
    const base2 = await queries.call('gdx_compare_scenarios', { files, symbol: 'x', base: 'transport2', filters: { Scenario: ['transport1'] }, fields: ['Level', 'Δ Level'] });
    assert.match(base2, /base: transport2/);
    assert.match(base2, /^seattle,new-york,transport1,50,-10$/m);
    // A symbol in only one file: its records count as missing in the other.
    const extra = await queries.call('gdx_compare_scenarios', { files, symbol: 'extra' });
    assert.match(extra, /\(not in transport1: its records count as missing there\)/);
    await assert.rejects(queries.call('gdx_compare_scenarios', { files: ['transport1.gdx'] }), /at least two GDX files/);
    await assert.rejects(queries.call('gdx_compare_scenarios', { files, base: 5 }), /Invalid "base"/);
    await assert.rejects(queries.call('gdx_compare_scenarios', { files, symbol: 'nope' }), /None of the files has a symbol "nope"/);
  });

  it('reports the solution status of all variables and equations', async () => {
    const text = await queries.call('gdx_solution_report', { file: 'solution.gdx', top: 3 });
    assert.match(text, /: 3 variables, 2 equations$/m);
    assert.match(text, /^4 records outside their bounds in 3 symbols; the largest infeasibility is 3 \(x\(i4\)\)$/m);
    assert.match(text, /^3 binding constraints .* in 2 equations$/m);
    // In the order of the file, not by name.
    assert.match(text, /max \|marginal\|,at lower,at upper\nx,Positive Variable,4,2,3,1,2,1,0\nz,Free Variable,1,0,,0,,0,0\ny,Binary Variable,2,0,,1,0\.5,1,1\ncap,Equation,4,1,1\.5,2,3,0,2\nbal,Equation,1,1,0\.25,1,100,0,0\n/);
    assert.match(text, /farthest outside first \(3 of 4\):\nrecord,type,Level,Lower,Upper,Infeasibility\nx\(i4\),Variable,23,0,20,3\ncap\(i3\),Equation,11\.5,-Inf,10,1\.5\nx\(i3\),Variable,-0\.5,0,20,0\.5\n/);
    // Only equations are binding constraints (x and y have reduced costs).
    assert.match(text, /largest \|marginal\| first \(3 of 3\):\nrecord,Level,Marginal,Lower,Upper\nbal,24\.75,100,25,25\ncap\(i1\),10,-3,-Inf,10\ncap\(i4\),10,Eps,-Inf,10$/);
    const feasible = await queries.call('gdx_solution_report', { file: 'transport1.gdx' });
    assert.match(feasible, /^No record is outside its bounds\.$/m);
    assert.doesNotMatch(feasible, /Records outside their bounds/);
    assert.match(await queries.call('gdx_solution_report', { file: 'edge.gdx' }), /0 variables, 0 equations\. The file holds no solution/);
  });

  it('reports wrong arguments as query errors', async () => {
    await assert.rejects(queries.call('gdx_read_symbol', { file: 'missing.gdx', symbol: 'x' }), (e: Error) => e instanceof QueryError && /File not found/.test(e.message));
    await assert.rejects(queries.call('gdx_read_symbol', { file: 'transport1.gdx', symbol: 'nope' }), /has no symbol "nope"/);
    await assert.rejects(queries.call('gdx_read_symbol', { file: 'transport1.gdx', symbol: 'x', sortBy: 'k' }), /Unknown column "k". The columns are: i, j, Level/);
    await assert.rejects(queries.call('gdx_read_symbol', { file: 'transport1.gdx', symbol: 'x', filters: { Level: ['a'] } }), /holds numbers/);
  });
});

describe('MCP server', () => {
  it('initializes, lists read-only tools and rejects unknown methods', async () => {
    const sent: any[] = [];
    const server = new McpServer((m) => sent.push(m), { log: () => {} });
    await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }));
    await server.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
    await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'resources/list' }));
    await server.handleLine('not json');
    server.dispose();
    assert.equal(sent.length, 4);
    assert.equal(sent[0].result.protocolVersion, '2025-03-26');
    assert.deepEqual(sent[0].result.capabilities, { tools: {} });
    assert.deepEqual(
      sent[1].result.tools.map((t: any) => [t.name, t.annotations.readOnlyHint]),
      TOOL_SPECS.map((t) => [t.name, true]),
    );
    assert.equal(sent[2].error.code, -32601);
    assert.equal(sent[3].error.code, -32700);
  });

  it('serves tool calls over stdio', { skip: resolved ? false : 'GAMS tools not found' }, async () => {
    const child = spawn(process.execPath, [path.resolve(__dirname, '../../mcp.js')], {
      cwd: fixtures,
      env: { ...process.env, GDX_BACKEND: 'gams', GDX_GAMS_SYSTEM_DIRECTORY: resolved!.location },
    });
    const answers = new Map<number, any>();
    const lines = readline.createInterface({ input: child.stdout });
    const done = new Promise<void>((resolve) =>
      lines.on('line', (l) => {
        const m = JSON.parse(l);
        answers.set(m.id, m);
        if (answers.size === 3) resolve();
      }),
    );
    const send = (m: object) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    send({ id: 2, method: 'tools/call', params: { name: 'gdx_read_symbol', arguments: { file: 'transport1.gdx', symbol: 'a' } } });
    send({ id: 3, method: 'tools/call', params: { name: 'gdx_read_symbol', arguments: { file: 'transport1.gdx', symbol: 'nope' } } });
    await done;
    child.stdin.end();
    assert.match(answers.get(2).result.content[0].text, /i,Value\nseattle,350\nsan-diego,600/);
    assert.equal(answers.get(3).result.isError, true);
    assert.match(answers.get(3).result.content[0].text, /has no symbol/);
  });
});

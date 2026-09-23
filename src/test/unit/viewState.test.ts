import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAX_FILES, StateStorage, ViewStateStore } from '../../viewState';

function memory(): StateStorage & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: <T>(k: string) => data.get(k) as T | undefined,
    update: async (k: string, v: unknown) => void data.set(k, JSON.parse(JSON.stringify(v))),
  };
}

describe('ViewStateStore', () => {
  it('saves, returns and clears the view of a file', async () => {
    const store = new ViewStateStore(memory(), true);
    await store.set('C:\\Data\\A.gdx', { selected: 'x' });
    // Windows paths are case-insensitive and may use either separator.
    assert.deepEqual(store.get('c:/data/a.gdx'), { selected: 'x' });
    await store.clear('C:\\DATA\\a.gdx');
    assert.equal(store.get('C:\\Data\\A.gdx'), undefined);
  });

  it('keeps the paths case-sensitive elsewhere', async () => {
    const store = new ViewStateStore(memory(), false);
    await store.set('/data/A.gdx', 1);
    assert.equal(store.get('/data/a.gdx'), undefined);
  });

  it('keeps only the most recently saved files', async () => {
    const store = new ViewStateStore(memory(), false);
    for (let i = 0; i <= MAX_FILES; i++) {
      await store.set(`/f${i}.gdx`, i);
      await new Promise((r) => setTimeout(r, 1));
    }
    assert.equal(store.get('/f0.gdx'), undefined);
    assert.equal(store.get(`/f${MAX_FILES}.gdx`), MAX_FILES);
    assert.equal(store.get('/f1.gdx'), 1);
  });
});

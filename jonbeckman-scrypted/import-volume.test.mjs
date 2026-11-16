import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, chmodSync, statSync, lstatSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'import-volume.sh');

function run(volume, importDir) {
  return execFileSync('/bin/sh', [script], {
    env: {
      ...process.env,
      SCRYPTED_IMPORT_ONLY: '1',
      SCRYPTED_VOLUME: volume,
      SCRYPTED_IMPORT: importDir,
    },
    encoding: 'utf8',
  });
}

function text(file) {
  return readFileSync(file, 'utf8');
}

function seed(dir) {
  mkdirSync(path.join(dir, 'scrypted.db'), { recursive: true });
  writeFileSync(path.join(dir, 'scrypted.db', 'CURRENT'), 'MANIFEST-000001\n');
  writeFileSync(path.join(dir, 'scrypted.db', '000001.ldb'), 'leveldb-bytes');
  mkdirSync(path.join(dir, 'plugins', 'homekit'), { recursive: true });
  writeFileSync(path.join(dir, 'plugins', 'homekit', 'settings.json'), '{"bridge":true}\n', { mode: 0o640 });
  writeFileSync(path.join(dir, '.hidden'), 'keep\n');
  symlinkSync('plugins/homekit/settings.json', path.join(dir, 'link-to-settings'));
}

test('starts with an empty volume when /import is absent', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'scrypted-import-'));
  const volume = path.join(root, 'volume');
  const output = run(volume, path.join(root, 'missing'));
  assert.match(output, /no .* mount/);
  assert.equal(existsSync(volume), false);
});

test('copies a Scrypted volume once and leaves the source unchanged', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'scrypted-import-'));
  const source = path.join(root, 'import');
  const volume = path.join(root, 'volume');
  seed(source);
  chmodSync(source, 0o555);
  chmodSync(path.join(source, 'scrypted.db'), 0o555);
  const before = text(path.join(source, 'scrypted.db', 'CURRENT'));
  const sourceStat = statSync(path.join(source, '.hidden'));

  const first = run(volume, source);
  assert.match(first, /imported/);
  assert.equal(text(path.join(volume, 'scrypted.db', 'CURRENT')), before);
  assert.equal(text(path.join(volume, 'scrypted.db', '000001.ldb')), 'leveldb-bytes');
  assert.equal(text(path.join(volume, 'plugins', 'homekit', 'settings.json')), '{"bridge":true}\n');
  assert.equal(statSync(path.join(volume, 'plugins', 'homekit', 'settings.json')).mode & 0o777, 0o640);
  assert.equal(statSync(path.join(volume, 'scrypted.db')).mode & 0o777, 0o555);
  assert.equal(text(path.join(volume, '.hidden')), 'keep\n');
  assert.equal(lstatSync(path.join(volume, 'link-to-settings')).isSymbolicLink(), true);
  assert.equal(text(path.join(source, 'scrypted.db', 'CURRENT')), before);
  assert.equal(statSync(path.join(source, '.hidden')).mtimeMs, sourceStat.mtimeMs);

  writeFileSync(path.join(volume, 'local-note.txt'), 'stay\n');
  writeFileSync(path.join(source, 'plugins', 'homekit', 'settings.json'), '{"bridge":false}\n');
  const second = run(volume, source);
  assert.match(second, /import skipped/);
  assert.equal(text(path.join(volume, 'local-note.txt')), 'stay\n');
  assert.equal(text(path.join(volume, 'plugins', 'homekit', 'settings.json')), '{"bridge":true}\n');
  assert.equal(text(path.join(source, 'scrypted.db', 'CURRENT')), before);
});

test('does not copy a directory that is not a Scrypted volume', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'scrypted-import-'));
  const source = path.join(root, 'import');
  const volume = path.join(root, 'volume');
  mkdirSync(source);
  writeFileSync(path.join(source, 'readme.txt'), 'not a database\n');
  const output = run(volume, source);
  assert.match(output, /no scrypted.db/);
  assert.equal(existsSync(path.join(volume, 'readme.txt')), false);
  assert.equal(text(path.join(source, 'readme.txt')), 'not a database\n');
});

test('does not copy when the import path is the volume', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'scrypted-import-'));
  const volume = path.join(root, 'volume');
  seed(volume);
  const output = run(volume, volume);
  assert.match(output, /is the app volume/);
  assert.equal(text(path.join(volume, '.hidden')), 'keep\n');
});

test('a retry after a staged database finishes the import', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'scrypted-import-'));
  const source = path.join(root, 'import');
  const volume = path.join(root, 'volume');
  seed(source);
  mkdirSync(path.join(volume, '.import-staging', 'scrypted.db'), { recursive: true });
  writeFileSync(path.join(volume, '.import-staging', 'scrypted.db', 'CURRENT'), 'partial\n');
  writeFileSync(path.join(volume, 'plugins-marker'), 'from-a-previous-attempt\n');

  const output = run(volume, source);
  assert.match(output, /imported/);
  assert.equal(text(path.join(volume, 'scrypted.db', 'CURRENT')), 'MANIFEST-000001\n');
  assert.equal(existsSync(path.join(volume, '.import-staging')), false);
  rmSync(root, { recursive: true, force: true });
});

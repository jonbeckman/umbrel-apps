// Replace ghcr.io/jonbeckman image tags with digest-pinned refs.
// Usage: node scripts/pin-images.mjs name=sha256:hex ...
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const pins = new Map();
for (const arg of process.argv.slice(2)) {
  const idx = arg.indexOf('=');
  if (idx < 1) throw new Error(`Expected name=sha256:hex, got ${arg}`);
  let digest = arg.slice(idx + 1);
  if (!digest.startsWith('sha256:')) digest = `sha256:${digest}`;
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error(`Bad digest for ${arg.slice(0, idx)}`);
  pins.set(arg.slice(0, idx), digest);
}

function versionOf(manifestPath) {
  const text = readFileSync(path.join(root, manifestPath), 'utf8');
  const version = text.match(/^version:\s*"([^"]+)"/m)?.[1];
  if (!version) throw new Error(`No version in ${manifestPath}`);
  return version;
}

const files = [
  {
    file: 'jonbeckman-github-runner/docker-compose.yml',
    version: versionOf('jonbeckman-github-runner/umbrel-app.yml'),
    names: ['github-runner-manager', 'github-runner-image'],
  },
  {
    file: 'jonbeckman-grafana-alloy/docker-compose.yml',
    version: versionOf('jonbeckman-grafana-alloy/umbrel-app.yml'),
    names: ['grafana-alloy-setup'],
  },
];

for (const item of files) {
  let text = readFileSync(path.join(root, item.file), 'utf8');
  for (const name of item.names) {
    const digest = pins.get(name);
    if (!digest) continue;
    const ref = `ghcr.io/jonbeckman/${name}:${item.version}`;
    const next = text.replaceAll(new RegExp(`${ref.replaceAll('/', '\\/')}(?:@sha256:[a-f0-9]{64})?`, 'g'), `${ref}@${digest}`);
    if (next === text) throw new Error(`${item.file} has no ${ref} to pin`);
    text = next;
  }
  writeFileSync(path.join(root, item.file), text);
}
console.log(`pinned ${[...pins.keys()].join(', ')}`);

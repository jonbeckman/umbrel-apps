// Check the community store layout without extra dependencies.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const errors = [];
const fail = (msg) => errors.push(msg);

const store = readFileSync(path.join(root, 'umbrel-app-store.yml'), 'utf8');
const storeId = store.match(/^id:\s*"?([a-z0-9-]+)"?/m)?.[1];
const storeName = store.match(/^name:\s*"(.+)"/m)?.[1];
if (storeId !== 'jonbeckman') fail(`store id is ${storeId}, expected jonbeckman`);
if (!storeName) fail('store name is missing');

const required = ['manifestVersion', 'id', 'category', 'name', 'version', 'tagline', 'description', 'developer', 'website', 'dependencies', 'repo', 'support', 'port', 'gallery', 'path', 'submitter', 'submission'];
const allowedFrom = /^(node|docker|grafana\/alloy|ghcr\.io\/actions\/actions-runner)[:@]/;

function apps() {
  return readdirSync(root).filter((name) => {
    if (!name.startsWith('jonbeckman-')) return false;
    return statSync(path.join(root, name)).isDirectory();
  });
}

for (const id of apps()) {
  const dir = path.join(root, id);
  const manifestText = readFileSync(path.join(dir, 'umbrel-app.yml'), 'utf8');
  for (const key of required) {
    if (!new RegExp(`^${key}:`, 'm').test(manifestText)) fail(`${id}: missing ${key}`);
  }
  const manifestId = manifestText.match(/^id:\s*(\S+)/m)?.[1];
  if (manifestId !== id) fail(`${id}: manifest id is ${manifestId}`);
  if (!id.startsWith(`${storeId}-`)) fail(`${id}: directory is not prefixed with the store id`);
  const version = manifestText.match(/^manifestVersion:\s*["']?([0-9.]+)/m)?.[1];
  if (version !== '1' && version !== '1.1') fail(`${id}: manifestVersion ${version} is not 1 or 1.1`);
  const compose = readFileSync(path.join(dir, 'docker-compose.yml'), 'utf8');
  if (/^\s*ports:/m.test(compose)) fail(`${id}: compose publishes ports`);
  if (!compose.includes(`APP_HOST: ${id}_`)) fail(`${id}: app_proxy APP_HOST does not use the app id`);
  if (!/PROXY_AUTH_ADD:\s*"true"/.test(compose)) fail(`${id}: app_proxy is not behind Umbrel auth`);
  const lines = compose.split('\n');
  lines.forEach((line, i) => {
    const image = line.match(/^\s*(?:image:|RUNNER_IMAGE:)\s*(\S+)/)?.[1];
    if (!image) return;
    const digest = /@sha256:[a-f0-9]{64}$/.test(image);
    const ours = image.startsWith('ghcr.io/jonbeckman/');
    const marked = /pinned-by-ci/.test(line) || /pinned-by-ci/.test(lines[i - 1] || '');
    if (!digest && !(ours && marked)) fail(`${id}: image is not digest-pinned: ${image}`);
    if (!ours && !digest) fail(`${id}: third-party image is not digest-pinned: ${image}`);
    const bare = image.split('@')[0];
    const slash = bare.lastIndexOf('/');
    const colon = bare.indexOf(':', slash + 1);
    const name = colon < 0 ? bare : bare.slice(0, colon);
    const allowed = name === 'docker' || name === 'grafana/alloy' || name.startsWith('ghcr.io/jonbeckman/');
    if (!allowed) fail(`${id}: image is not an allowed base or this store's image: ${name}`);
  });
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === '.git' || name === 'node_modules') continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

for (const file of walk(root)) {
  const rel = path.relative(root, file);
  const text = readFileSync(file, 'utf8');
  if (/github_pat_[A-Za-z0-9_]{20,}/.test(text) || /glc_[A-Za-z0-9_]{20,}/.test(text)) fail(`${rel}: looks like a committed credential`);
  if (rel.endsWith('Dockerfile')) {
    for (const match of text.matchAll(/^FROM\s+(\S+)/gm)) {
      const image = match[1];
      if (image === 'node') continue;
      if (!/@sha256:[a-f0-9]{64}/.test(image)) fail(`${rel}: FROM is not digest-pinned: ${image}`);
      const name = image.split('@')[0].replace(/:.+$/, '');
      if (!allowedFrom.test(`${name}:`)) fail(`${rel}: base image is not on the allow list: ${name}`);
    }
  }
  if (rel.startsWith('.github/workflows/') && rel.endsWith('.yml')) {
    for (const match of text.matchAll(/uses:\s*([^@\s]+)@([^\s#]+)/g)) {
      if (!/^[0-9a-f]{40}$/.test(match[2])) fail(`${rel}: action is not SHA-pinned: ${match[1]}@${match[2]}`);
    }
  }
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`store ${storeId} (${storeName}); apps: ${apps().join(', ')}`);

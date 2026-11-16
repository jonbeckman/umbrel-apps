// Bump an app version when its compose image refs differ from a base git
// revision. The desired version is always computed from the base manifest,
// so running this again on the same diff does not bump a second time.
//
// Patch when the image tag's major.minor is unchanged (digest or patch).
// Minor, resetting patch to 0, when any changed image's major or minor
// increased. A digest with no semver in the tag is a patch bump.
//
// Usage: node scripts/bump-for-image-updates.mjs --base origin/master
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function imageRefs(compose) {
  const refs = new Map();
  for (const line of compose.split('\n')) {
    const match = line.match(/^\s*(?:image:|RUNNER_IMAGE:)\s*(\S+)\s*$/);
    if (!match) continue;
    const parsed = parseRef(match[1]);
    refs.set(parsed.name, parsed);
  }
  return refs;
}

export function parseRef(ref) {
  const at = ref.lastIndexOf('@sha256:');
  const digest = at < 0 ? '' : ref.slice(at + 1);
  const bare = at < 0 ? ref : ref.slice(0, at);
  const slash = bare.lastIndexOf('/');
  const colon = bare.indexOf(':', slash + 1);
  const name = colon < 0 ? bare : bare.slice(0, colon);
  const tag = colon < 0 ? '' : bare.slice(colon + 1);
  return { name, tag, digest, ref: digest ? `${bare}@${digest}` : bare };
}

export function semver(tag) {
  const match = tag.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

// minor when an upstream major or minor increased; otherwise patch.
export function bumpKind(changes) {
  for (const change of changes) {
    const before = semver(change.from.tag);
    const after = semver(change.to.tag);
    if (!before || !after) continue;
    if (after.major > before.major || (after.major === before.major && after.minor > before.minor)) return 'minor';
  }
  return 'patch';
}

export function bumpVersion(version, kind) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw new Error(`Version is not x.y.z: ${version}`);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

export function imageChanges(baseCompose, headCompose) {
  const base = imageRefs(baseCompose);
  const head = imageRefs(headCompose);
  const names = new Set([...base.keys(), ...head.keys()]);
  const changes = [];
  for (const name of [...names].sort()) {
    const from = base.get(name);
    const to = head.get(name);
    if (!from || !to || from.ref === to.ref) continue;
    changes.push({ name, from, to });
  }
  return changes;
}

function shortDigest(digest) {
  if (!digest) return '';
  return digest.replace(/^sha256:/, '').slice(0, 12);
}

function refText(parsed) {
  const digest = shortDigest(parsed.digest);
  if (parsed.tag && digest) return `${parsed.tag} (${digest})`;
  return parsed.tag || digest || parsed.ref;
}

export function releaseNote(changes) {
  const parts = changes.map((change) => `${change.name} ${refText(change.from)} -> ${refText(change.to)}`);
  return `Image update: ${parts.join('; ')}.`;
}

export function retargetOwnImages(compose, fromVersion, toVersion) {
  if (fromVersion === toVersion) return compose;
  return compose.replaceAll(
    new RegExp(`(ghcr\\.io/jonbeckman/[^\\s:@]+):${fromVersion.replaceAll('.', '\\.')}(?=@|\\s|$)`, 'g'),
    `$1:${toVersion}`,
  );
}

export function setVersion(manifest, version) {
  if (!/^version:\s*"[^"]+"/m.test(manifest)) throw new Error('version field missing');
  return manifest.replace(/^version:\s*"[^"]+"/m, `version: "${version}"`);
}

export function setReleaseNotes(manifest, note) {
  const body = note.replace(/\s+/g, ' ').trim();
  const next = `releaseNotes: >-\n  ${body}\n`;
  if (/^releaseNotes:\s*>-\n(?:[ \t].*\n)*/m.test(manifest)) {
    return manifest.replace(/^releaseNotes:\s*>-\n(?:[ \t].*\n)*/m, next);
  }
  if (/^releaseNotes:\s*.+$/m.test(manifest)) {
    return manifest.replace(/^releaseNotes:\s*.+$/m, next.trimEnd());
  }
  throw new Error('releaseNotes field missing');
}

export function setReadmeVersion(readme, appId, version) {
  const row = new RegExp(`^(\\|[^\\n]*\\| \`${appId}\` \\| )\\d+\\.\\d+\\.\\d+`, 'm');
  if (!row.test(readme)) throw new Error(`README table has no row for ${appId}`);
  return readme.replace(row, `$1${version}`);
}

export function planApp({ appId, baseCompose, baseVersion, headCompose, headManifest, readme }) {
  const changes = imageChanges(baseCompose, headCompose);
  if (changes.length === 0) return { changed: false };
  const kind = bumpKind(changes);
  const version = bumpVersion(baseVersion, kind);
  const notes = releaseNote(changes);
  const compose = retargetOwnImages(headCompose, baseVersion, version);
  const manifest = setReleaseNotes(setVersion(headManifest, version), notes);
  const nextReadme = setReadmeVersion(readme, appId, version);
  const changed = compose !== headCompose || manifest !== headManifest || nextReadme !== readme;
  return { changed, kind, version, notes, compose, manifest, readme: nextReadme };
}

function gitShow(rev, file) {
  try {
    return execFileSync('git', ['show', `${rev}:${file}`], { cwd: root, encoding: 'utf8' });
  } catch {
    return null;
  }
}

function versionOf(manifest) {
  const version = manifest.match(/^version:\s*"([^"]+)"/m)?.[1];
  if (!version) throw new Error('No version in manifest');
  return version;
}

function apps() {
  return readdirSync(root).filter((name) => {
    if (!name.startsWith('jonbeckman-')) return false;
    const dir = path.join(root, name);
    return statSync(dir).isDirectory() && statSync(path.join(dir, 'umbrel-app.yml')).isFile();
  });
}

function baseArg() {
  const index = process.argv.indexOf('--base');
  const base = index >= 0 ? process.argv[index + 1] : '';
  if (!base) throw new Error('Pass --base <git-rev>');
  return base;
}

function main() {
  const base = baseArg();
  let readme = readFileSync(path.join(root, 'README.md'), 'utf8');
  const bumped = [];
  for (const appId of apps()) {
    const composePath = path.join(root, appId, 'docker-compose.yml');
    const manifestPath = path.join(root, appId, 'umbrel-app.yml');
    let headCompose = '';
    try {
      headCompose = readFileSync(composePath, 'utf8');
    } catch {
      continue;
    }
    const baseCompose = gitShow(base, `${appId}/docker-compose.yml`);
    const baseManifest = gitShow(base, `${appId}/umbrel-app.yml`);
    if (baseCompose == null || baseManifest == null) continue;
    const headManifest = readFileSync(manifestPath, 'utf8');
    const planned = planApp({
      appId,
      baseCompose,
      baseVersion: versionOf(baseManifest),
      headCompose,
      headManifest,
      readme,
    });
    if (!planned.changed) continue;
    writeFileSync(composePath, planned.compose);
    writeFileSync(manifestPath, planned.manifest);
    readme = planned.readme;
    bumped.push(`${appId} ${versionOf(baseManifest)} -> ${planned.version} (${planned.kind})`);
  }
  if (bumped.length) writeFileSync(path.join(root, 'README.md'), readme);
  if (bumped.length === 0) console.log('No app version bump.');
  else console.log(bumped.join('\n'));
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) main();

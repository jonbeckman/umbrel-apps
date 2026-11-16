// Decide whether an image-update PR may auto-merge.
// stdin: { threads: [{ isResolved, author }], reviews: [{ author, state }], comments: [{ author }] }
// A blocking author is jonbeckman, Bugbot (login contains "bugbot", or
// cursor[bot]), or a lint/format bot. An unresolved review thread or a
// CHANGES_REQUESTED review from one of them blocks. Plain issue comments
// do not, because they cannot be marked resolved.
import { readFileSync } from 'node:fs';

export function blocksAuthor(login) {
  if (!login) return false;
  const name = login.toLowerCase();
  if (name === 'jonbeckman') return true;
  if (name.includes('bugbot')) return true;
  if (name === 'cursor[bot]') return true;
  if (name === 'github-actions[bot]' || name === 'renovate[bot]') return false;
  return /(^|[^a-z])(lint|format|prettier|eslint)([^a-z]|$)/.test(name);
}

export function reviewBlocks(input) {
  for (const thread of input.threads ?? []) {
    if (thread.isResolved) continue;
    if (blocksAuthor(thread.author)) return `${thread.author} has an unresolved review thread`;
  }
  const latest = new Map();
  for (const review of input.reviews ?? []) {
    if (review.author) latest.set(review.author, review.state);
  }
  for (const [author, state] of latest) {
    if (state === 'CHANGES_REQUESTED' && blocksAuthor(author)) return `${author} requested changes`;
  }
  return '';
}

function main() {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const reason = reviewBlocks(input);
  if (reason) {
    console.log(reason);
    process.exit(2);
  }
  console.log('clear');
}

if (process.argv[1] && process.argv[1].endsWith('review-gate.mjs')) main();

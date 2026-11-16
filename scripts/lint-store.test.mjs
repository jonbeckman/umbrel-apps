import assert from 'node:assert/strict';
import test from 'node:test';

import { servicesMissingCommand } from './lint-store.mjs';

test('entrypoint without command is rejected', () => {
  const compose = `
services:
  server:
    image: example:1
    entrypoint: ["/bin/sh", "/import-volume.sh"]
  web:
    image: example:1
    entrypoint: ["/bin/sh", "/start.sh"]
    command: ["serve"]
`;
  assert.deepEqual(servicesMissingCommand(compose), ['server']);
});

test('entrypoint with command is accepted', () => {
  const compose = `
services:
  server:
    entrypoint: ["/bin/sh", "/import-volume.sh"]
    command: ["/bin/sh", "-c", "ulimit -c 0; exec npm --prefix /server exec scrypted-serve"]
`;
  assert.deepEqual(servicesMissingCommand(compose), []);
});

test('a service that only sets command is accepted', () => {
  const compose = `
services:
  dind:
    command:
      - dockerd
`;
  assert.deepEqual(servicesMissingCommand(compose), []);
});

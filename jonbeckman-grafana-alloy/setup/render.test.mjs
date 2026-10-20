import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSecrets, publicStatus, renderAlloy } from './render.mjs';

const secrets = {
  promUrl: 'https://prometheus-prod-00.grafana.net/api/prom/push',
  promUser: '123',
  lokiUrl: 'https://logs-prod-00.grafana.net/loki/api/v1/push',
  lokiUser: '456',
  otlpUrl: 'https://otlp-gateway-prod-us-east-0.grafana.net/otlp',
  otlpUser: '789',
  token: 'glc_exampletoken',
};

test('unconfigured alloy config ships nothing and hides container env', () => {
  const text = renderAlloy(null);
  assert.match(text, /managed: unconfigured/);
  assert.equal(text.includes('password'), false);
  assert.match(text, /store_container_labels = false/);
  assert.match(text, /jonbeckman-github-runner_manager_1:3500/);
  assert.match(text, /forward_to = \[\]/);
});

test('configured config escapes secrets and opens OTLP only on the docker network', () => {
  const token = 'glc_"quoted"';
  const text = renderAlloy({ ...secrets, token });
  assert.match(text, /managed: configured/);
  assert.match(text, /0\.0\.0\.0:4317/);
  assert.match(text, /0\.0\.0\.0:4318/);
  assert.ok(text.includes(JSON.stringify(token)));
  assert.equal(text.includes('glc_"quoted"\n'), false);
  assert.throws(() => checkSecrets({ ...secrets, promUrl: 'http://example' }), /https/);
  assert.throws(() => checkSecrets({ ...secrets, token: 'has space' }), /Token/);
  assert.equal(JSON.stringify(publicStatus({ ...secrets, token })).includes('glc_'), false);
});

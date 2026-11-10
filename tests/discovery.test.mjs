/**
 * Unit tests for the automatic QQ channel discovery in index.js.
 *
 * Exercises the four discovery sources (explicit config, qq-bridge config,
 * SnowLuma account config, saved channel.json override) without networking.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveConfig } from '../index.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-quote-archive-discovery-'));
const previousHome = process.env.DSH_HOME;
process.env.DSH_HOME = tmp;

try {
  const snowlumaHome = path.join(tmp, 'SnowLuma');
  mkdirSync(path.join(snowlumaHome, 'config'), { recursive: true });
  writeFileSync(
    path.join(snowlumaHome, 'config', 'onebot_3266983948.json'),
    JSON.stringify({
      networks: {
        httpServers: [{ name: 'http-default', host: '127.0.0.1', port: 3999, accessToken: 'snow-token' }],
      },
      wsServers: [],
    }),
    'utf8',
  );

  // 1) SnowLuma account config is discovered from an explicit snowlumaHome.
  let config = resolveConfig({ channel: { snowlumaHome } });
  assert.equal(config.channel.httpUrl, 'http://127.0.0.1:3999');
  assert.equal(config.channel.accessToken, 'snow-token');
  assert.equal(config.channel.source, 'snowluma');
  assert.equal(config.channel.enabled, true);
  assert.equal(config.channel.auto, true);

  // 2) Explicit plugin config wins over discovery.
  config = resolveConfig({
    channel: { snowlumaHome, httpUrl: 'http://127.0.0.1:3001', accessToken: 'explicit-token' },
  });
  assert.equal(config.channel.httpUrl, 'http://127.0.0.1:3001');
  assert.equal(config.channel.accessToken, 'explicit-token');
  assert.equal(config.channel.source, 'config');

  // 3) enabled:false disables the channel even when a gateway is discoverable.
  config = resolveConfig({ channel: { snowlumaHome, enabled: false } });
  assert.equal(config.channel.enabled, false);

  // 4) qq-bridge config.json is discovered from an explicit path.
  const bridgeConfig = path.join(tmp, 'qq-bridge.json');
  writeFileSync(
    bridgeConfig,
    JSON.stringify({ snowluma: { httpUrl: 'http://127.0.0.1:3002', accessToken: 'bridge-token' } }),
    'utf8',
  );
  config = resolveConfig({ channel: { qqBridgeConfig: bridgeConfig } });
  assert.equal(config.channel.httpUrl, 'http://127.0.0.1:3002');
  assert.equal(config.channel.accessToken, 'bridge-token');
  assert.equal(config.channel.source, 'qq-bridge');

  // 5) The channel.json override saved by the panel wins over bundle config.
  const archiveDir = path.join(tmp, 'storages', 'quote-archive');
  mkdirSync(archiveDir, { recursive: true });
  writeFileSync(
    path.join(archiveDir, 'channel.json'),
    JSON.stringify({ enabled: true, httpUrl: 'http://127.0.0.1:3003', accessToken: 'override-token', source: 'snowluma' }),
    'utf8',
  );
  config = resolveConfig({ channel: { enabled: false } });
  assert.equal(config.channel.enabled, true);
  assert.equal(config.channel.httpUrl, 'http://127.0.0.1:3003');
  assert.equal(config.channel.accessToken, 'override-token');
  assert.equal(config.channel.source, 'snowluma');

  console.log('discovery OK: config + qq-bridge + SnowLuma + channel.json override');
} finally {
  if (previousHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousHome;
  rmSync(tmp, { recursive: true, force: true });
}

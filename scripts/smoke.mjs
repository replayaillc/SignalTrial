import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RecorderStore } from '../src/main/recorder-store.js';

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signaltrail-smoke-'));
const store = new RecorderStore(tmpDir);
await store.ready();

const session = await store.startSession({
  test: true,
  task: {
    description: 'Smoke test task',
    label: 'Smoke test task'
  },
  initialContext: {
    ok: true,
    app: {
      name: 'Smoke App',
      bundleId: 'dev.signaltrail.smoke'
    },
    window: {
      title: 'Smoke Window'
    }
  }
});

assert.equal(store.isRecording(), true);
assert.equal(typeof session.id, 'string');

await store.appendEvent('mouse', {
  kind: 'mousemove',
  x: 12,
  y: 34
});

await store.appendEvent('cursor', {
  x: 50,
  y: 60
});

await store.appendEvent('context', {
  ok: true,
  app: {
    name: 'Google Chrome',
    bundleId: 'com.google.Chrome'
  },
  window: {
    title: 'Gmail - Inbox'
  },
  browser: {
    title: 'Gmail',
    url: 'https://mail.google.com/'
  }
});

const fakePng = Buffer.from('89504e470d0a1a0a', 'hex');
const screenshot = await store.saveScreenshot(fakePng, {
  trigger: 'smoke',
  width: 1,
  height: 1
});

assert.equal(screenshot.file, 'screenshots/screenshot-000001.png');
assert.equal(screenshot.bytes, fakePng.length);

const videoChunk = Buffer.from('webm-smoke-chunk');
const video = await store.appendVideoChunk(videoChunk, {
  chunkIndex: 1,
  mimeType: 'video/webm'
});

assert.equal(video.ok, true);
assert.equal(video.bytes, videoChunk.length);

await store.stopSession({
  ok: true,
  outcome: {
    status: 'success',
    notes: 'Smoke completed'
  }
});

const eventsJsonl = await fs.readFile(session.eventsPath, 'utf8');
const records = eventsJsonl
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line));

assert.deepEqual(
  records.map((record) => record.type),
  ['session-start', 'mouse', 'cursor', 'context', 'screenshot', 'video-chunk', 'session-stop']
);

await fs.access(path.join(session.dir, screenshot.file));
await fs.access(session.videoPath);

const database = JSON.parse(await fs.readFile(store.getDatabasePath(), 'utf8'));
assert.equal(database.sessions.length, 1);
assert.equal(database.sessions[0].status, 'saved');
assert.equal(database.sessions[0].task.description, 'Smoke test task');
assert.equal(database.sessions[0].outcome.status, 'success');
assert.equal(database.sessions[0].counts.mouse, 2);
assert.equal(database.sessions[0].counts.context, 1);
assert.equal(database.sessions[0].counts.screenshots, 1);
assert.equal(database.sessions[0].counts.videoChunks, 1);
assert.equal(database.sessions[0].counts.videoBytes, videoChunk.length);

console.log(`Smoke test passed: ${session.dir}`);

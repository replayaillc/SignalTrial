import fs from 'node:fs/promises';
import path from 'node:path';

const appResources = path.join(
  process.cwd(),
  'dist',
  'SignalTrail-darwin-arm64',
  'SignalTrail.app',
  'Contents',
  'Resources',
  'app.asar.unpacked'
);

const copies = [
  ['src/main/keyboard-monitor.swift', 'src/main/keyboard-monitor.swift'],
  ['build/Release/keyboard_monitor.node', 'build/Release/keyboard_monitor.node']
];

for (const [source, destination] of copies) {
  const target = path.join(appResources, destination);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(path.join(process.cwd(), source), target);
}

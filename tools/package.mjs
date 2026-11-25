import { execFileSync } from 'node:child_process';
import { access, mkdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, 'application.manifest.json'), 'utf8'));
const output = path.join(root, 'dist', `meeting-recorder-${manifest.version}.zip`);
const pending = path.join(root, 'dist', `meeting-recorder-${process.pid}.tmp.zip`);
const dependencies = ['node_modules/@centaurai/wanx-host-sdk', 'node_modules/ws'];
for (const directory of dependencies) {
  await access(path.join(root, directory, 'package.json')).catch(() => {
    throw new Error('请先放入 WANX Host SDK 0.3.0 的 tarball，并运行 npm ci。');
  });
}
await mkdir(path.dirname(output), { recursive: true });
try {
  execFileSync('zip', ['-q', '-X', '-r', pending, 'application.manifest.json', 'package.json',
    'main.mjs', 'recording', ...dependencies,
    '-x', '*/.DS_Store'], { cwd: root, stdio: 'inherit' });
  await rename(pending, output);
  console.log(output);
} finally {
  await rm(pending, { force: true });
}

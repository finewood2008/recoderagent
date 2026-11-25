import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, dialog, session, systemPreferences } from 'electron';
import { attachMedia } from './recording/lib/media.mjs';
import { startRecordingServer } from './recording/server.mjs';

const title = '会议录音智能体';
let host;
let server;
let window;
process.umask(0o077);

async function profileDirectory() {
  if (!host) return path.join(app.getPath('userData'), 'recordings-local');
  const context = await host.context();
  const owner = context.principalId || context.accountId || context.user?.id;
  if (context.connection !== 'ready' || !context.boxId || !owner) throw new Error('请在记忆盒子连接盒子后重新打开。');
  const scope = createHash('sha256').update(JSON.stringify([owner, context.boxId, context.dataIdentity?.profileId])).digest('hex');
  return path.join(app.getPath('userData'), 'recordings', scope);
}

async function openRecorder() {
  if (Object.keys(process.env).some(key => key.startsWith('WANX_HOST_'))) {
    const { fromEnvironment } = await import('@centaurai/wanx-host-sdk');
    host = fromEnvironment();
  }
  if (!host) {
    app.setName(title);
    if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  }
  const dataDir = await profileDirectory();
  host?.onSessionInvalidated(() => app.quit());
  attachMedia(host);
  if (process.platform === 'darwin') {
    for (const [tool, key] of [['ffmpeg', 'FFMPEG_BIN'], ['ffprobe', 'FFPROBE_BIN']]) {
      const candidate = ['/opt/homebrew/opt/ffmpeg-full/bin', '/opt/homebrew/bin', '/usr/local/bin']
        .map(directory => path.join(directory, tool)).find(existsSync);
      if (candidate && !process.env[key]) process.env[key] = candidate;
    }
  }
  const viewKey = randomBytes(32).toString('hex');
  server = await startRecordingServer(dataDir, viewKey);
  const entry = server.origin + '/';
  const partition = session.fromPartition('meeting-recording');
  partition.webRequest.onBeforeSendHeaders({ urls: [server.origin + '/*'] }, (details, reply) => {
    reply({ requestHeaders: { ...details.requestHeaders, 'X-Recording-View': viewKey } });
  });
  window = new BrowserWindow({
    title, width: 1240, height: 820, minWidth: 620, minHeight: 520,
    show: false, backgroundColor: '#faf7f2',
    webPreferences: { session: partition, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  const contents = window.webContents;
  const ownsView = (source, origin) => source === contents
    && contents.getURL().split('#')[0] === entry
    && (!origin || origin === server.origin || origin === entry);
  partition.setPermissionCheckHandler((source, permission, origin, details) =>
    permission === 'media' && details.mediaType === 'audio' && ownsView(source, origin));
  partition.setPermissionRequestHandler((source, permission, reply, details) => {
    if (permission !== 'media' || !ownsView(source, details.securityOrigin)
        || details.mediaTypes?.length !== 1 || details.mediaTypes[0] !== 'audio') return reply(false);
    if (process.platform === 'darwin') void systemPreferences.askForMediaAccess('microphone').then(reply, () => reply(false));
    else reply(true);
  });
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', event => event.preventDefault());
  contents.on('will-redirect', event => event.preventDefault());
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  await window.loadURL(entry);
  window.show();
}

app.on('window-all-closed', () => app.quit());
app.once('will-quit', () => {
  host?.close();
  server?.close();
});

void app.whenReady().then(openRecorder).catch(error => {
  console.error('会议录音智能体启动失败', error.code || error.message);
  dialog.showErrorBox(title, error.code === 'HOST_SESSION_EXPIRED'
    ? '连接已结束，请从记忆盒子重新打开。'
    : '无法打开会议录音智能体，请检查盒子连接后重试。');
  app.exit(1);
});

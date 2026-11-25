import { createReadStream, promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { sha256, withLock, HttpError } from './util.mjs';
import { fileDigest } from './media.mjs';

async function spaceFolder(drive, parent, name) {
  return withLock('folder:' + parent + '/' + name, async () => {
    const find = async () => (await drive.list({parent})).items.find(row => row.name === name && row.kind === 'folder');
    const existing = await find();
    if (existing) return existing.id;
    try { return (await drive.mkdir({ parent, name })).id; }
    catch (error) { const created = await find(); if (created) return created.id; throw error; }
  });
}

export async function saveSpaceFiles(drive, project, files) {
  const root = await spaceFolder(drive, '', '录音记录');
  const parent = await spaceFolder(drive, root, project.folder);
  const list = (await drive.list({parent})).items;
  const ids = [];
  for (const file of files) {
    const name = path.basename(file);
    const digest = await fileDigest(file);
    const existing = list.find(item => item.name === name);
    if (existing && existing.digest !== digest) throw new HttpError(409, '空间已有同名文件且内容不同，请先检查该文件。');
    if (existing) { ids.push(existing.id); continue; }
    const size = (await fs.stat(file)).size;
    const uploadId = sha256(Buffer.from([project.mediaScope, parent, name, digest].join('/'))).slice(0,32);
    const data = createReadStream(file);
    try { ids.push((await drive.upload({parent, name, size, uploadId, data})).id); }
    finally { data.destroy(); }
  }
  return { folder: parent, files: ids };
}

export function submitAccessoryMemory(payload) {
  if (!process.send) throw new HttpError(503, '请从客户端打开配件以保存记忆。');
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const finish = (error, result) => {
      clearTimeout(timer);
      process.off('message', receive);
      if (error) reject(new HttpError(503, '记忆暂未保存，请稍后重试。'));
      else resolve({ id: result });
    };
    const receive = message => {
      if (message?.type === 'memory-result' && message.id === id) finish(!message.memoryId, message.memoryId);
    };
    const timer = setTimeout(() => finish(true), 40000);
    process.on('message', receive);
    process.send({ type:'accessory-memory', id, payload }, error => { if (error) finish(true); });
  });
}

export function queryAccessoryMemory(query) {
  if (!process.send || typeof query !== 'string' || !query.trim()) return Promise.resolve([]);
  const id = randomUUID();
  return new Promise((resolve) => {
    const finish = (matches) => {
      clearTimeout(timer);
      process.off('message', receive);
      resolve(Array.isArray(matches) ? matches : []);
    };
    const receive = (message) => {
      if (message?.type === 'memory-context-result' && message.id === id) finish(message.matches);
    };
    const timer = setTimeout(() => finish([]), 3800);
    process.on('message', receive);
    try {
      process.send({ type: 'memory-context-request', id, query: query.trim().slice(0, 300) }, (err) => {
        if (err) finish([]);
      });
    } catch {
      finish([]);
    }
  });
}

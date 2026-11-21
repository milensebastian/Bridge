// The browser download consumes OPFS files on demand. Only ZIP metadata stays in memory.
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
const prefix = '/bridge-download/';
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  const id = url.pathname.slice(prefix.length);
  if (url.origin === self.location.origin && url.pathname.startsWith(prefix) && /^[a-f0-9-]{36}\/[a-f0-9-]{36}$/.test(id)) {
    event.respondWith(download(id));
  }
});

async function download(id) {
  try {
    const root = await navigator.storage.getDirectory();
    const [transferId, token] = id.split('/');
    const parent = await root.getDirectoryHandle(transferId);
    const dir = await parent.getDirectoryHandle(token);
    const manifest = await (await dir.getFileHandle('manifest')).getFile();
    const {files, checksums} = JSON.parse(await manifest.text());
    const base = await dir.getDirectoryHandle('files');
    async function open(item) {
      let folder = base;
      for (const segment of item.relativePath.split('/').slice(0,-1)) folder = await folder.getDirectoryHandle(segment);
      return (await folder.getFileHandle(item.name)).getFile();
    }
    const single = files.length === 1 && !files[0].relativePath.includes('/');
    const name = single ? files[0].name : 'Bridge files.zip';
    const parts = single ? contents(await open(files[0])) : archive(files, checksums, open);
    const stream = new ReadableStream({
      async pull(controller) {
        const next = await parts.next();
        if (next.done) {
          controller.close();
          await parent.removeEntry(token,{recursive:true}).catch(()=>{});
          await root.removeEntry(transferId).catch(()=>{});
          for (const client of await self.clients.matchAll()) client.postMessage({type:'bridge-download-saved', url:prefix+id});
        } else controller.enqueue(next.value);
      },
      async cancel() { await parts.return(); }
    });
    return new Response(stream,{headers:{'Content-Type':'application/octet-stream','Cache-Control':'no-store',
      'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(name).replace(/['()*]/g, c => '%'+c.charCodeAt(0).toString(16)),
      ...(single ? {'Content-Length': String(files[0].size)} : {})}});
  } catch { return new Response('This transfer has already downloaded or expired.',{status:410}); }
}
async function* contents(file) {
  const reader = file.stream().getReader();
  try {
    while (true) {
      const {done,value} = await reader.read();
      if (done) break;
      yield value;
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
}
// Store-only ZIP64. Sizes and CRCs were measured while writing the original files.
function record(size) {
  const bytes = new Uint8Array(size), view = new DataView(bytes.buffer);
  let pos = 0;
  return {bytes, u16(n){view.setUint16(pos,n,true); pos+=2;}, u32(n){view.setUint32(pos,n,true); pos+=4;},
    u64(n){view.setBigUint64(pos,BigInt(n),true); pos+=8;}, put(data){bytes.set(data,pos); pos+=data.length;}};
}
function fileRecord(item, crc, offset, central) {
  const name = new TextEncoder().encode(item.relativePath);
  const extra = central ? 28 : 20;
  const r = record((central ? 46 : 30) + name.length + extra);
  r.u32(central ? 0x02014b50 : 0x04034b50);
  if (central) r.u16(45);
  r.u16(45); r.u16(0x800); r.u16(0); r.u16(0); r.u16(33);
  r.u32(crc); r.u32(0xffffffff); r.u32(0xffffffff); r.u16(name.length); r.u16(extra);
  if (central) { r.u16(0); r.u16(0); r.u16(0); r.u32(0); r.u32(0xffffffff); }
  r.put(name); r.u16(1); r.u16(extra - 4); r.u64(item.size); r.u64(item.size);
  if (central) r.u64(offset);
  return r.bytes;
}
async function* archive(files, checksums, open) {
  const offsets = [];
  let position = 0n;
  for (const [i,item] of files.entries()) {
    offsets.push(position);
    const header = fileRecord(item,checksums[i],position,false);
    yield header;
    yield* contents(await open(item));
    position += BigInt(header.length) + BigInt(item.size);
  }
  const start = position;
  for (const [i,item] of files.entries()) {
    const header = fileRecord(item,checksums[i],offsets[i],true);
    yield header;
    position += BigInt(header.length);
  }
  const end = record(98);
  end.u32(0x06064b50); end.u64(44); end.u16(45); end.u16(45); end.u32(0); end.u32(0);
  end.u64(files.length); end.u64(files.length); end.u64(position-start); end.u64(start);
  end.u32(0x07064b50); end.u32(0); end.u64(position); end.u32(1);
  end.u32(0x06054b50); end.u16(0); end.u16(0); end.u16(65535); end.u16(65535); end.u32(0xffffffff); end.u32(0xffffffff); end.u16(0);
  yield end.bytes;
}

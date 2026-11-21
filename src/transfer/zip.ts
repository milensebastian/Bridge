import type {Item} from './protocol';

// Store-only ZIP64 records; file data is written directly into the archive.
function record(size: number) {
  const bytes = new Uint8Array(size), view = new DataView(bytes.buffer);
  let pos = 0;
  return {bytes, u16(n: number){view.setUint16(pos,n,true); pos+=2;}, u32(n: number){view.setUint32(pos,n,true); pos+=4;},
    u64(n: number | bigint){view.setBigUint64(pos,BigInt(n),true); pos+=8;}, put(data: Uint8Array){bytes.set(data,pos); pos+=data.length;}};
}
export function fileRecord(item: Item, crc: number, offset: number, central: boolean) {
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
export function archiveEnd(count: number, start: number, position: number) {
  const end = record(98);
  end.u32(0x06064b50); end.u64(44); end.u16(45); end.u16(45); end.u32(0); end.u32(0);
  end.u64(count); end.u64(count); end.u64(position-start); end.u64(start);
  end.u32(0x07064b50); end.u32(0); end.u64(position); end.u32(1);
  end.u32(0x06054b50); end.u16(0); end.u16(0); end.u16(65535); end.u16(65535); end.u32(0xffffffff); end.u32(0xffffffff); end.u16(0);
  return end.bytes;
}

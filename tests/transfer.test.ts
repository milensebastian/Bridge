import {test} from 'node:test';
import assert from 'node:assert/strict';
import {crc32} from '../src/transfer/crc32';
import {frame,aad,validateManifest,windowBytes,type Wire} from '../src/transfer/protocol';
import {FileSender} from '../src/transfer/fileSender';

test('CRC32 and encrypted headers preserve offsets beyond 4 GiB',async()=>{
  const data = new TextEncoder().encode('123456789');
  assert.equal(crc32(data),0xcbf43926);
  const key = await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  const id = crypto.randomUUID(), offset = 2 ** 32 + 123;
  const buffer = await frame(key,7,offset,data,id);
  assert.equal(new DataView(buffer).getBigUint64(5),BigInt(offset));
  const decode = () => crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(buffer,17,12),additionalData:aad(new Uint8Array(buffer),id)},key,new Uint8Array(buffer,29));
  assert.deepEqual(new Uint8Array(await decode()),data);
  new Uint8Array(buffer)[12] ^= 1;
  await assert.rejects(decode());
});

test('sender waits for receiver storage credit and cancels while paused',async()=>{
  const key = await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  const file = new File([new Uint8Array(windowBytes+1000)],'sample');
  let bytes = 0;
  let full!: () => void;
  const stalled = new Promise<void>(resolve=>{full=resolve;});
  const wire: Wire = {
    control:async m=>{if(m.type==='transfer-manifest') sender.acknowledge(0);},
    binary:async b=>{bytes+=b.byteLength-45; if(bytes===windowBytes) full();}
  };
  const sender = new FileSender([{file,path:'folder/sample'}],wire,key);
  const run = sender.run();
  await stalled;
  sender.pause(true);
  sender.acknowledge(bytes);
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(bytes,windowBytes);
  sender.cancel();
  await assert.rejects(run,/cancelled/);
  const bad = structuredClone(sender.manifest);
  bad.files[0].relativePath = '../sample';
  assert.throws(()=>validateManifest(bad));
});

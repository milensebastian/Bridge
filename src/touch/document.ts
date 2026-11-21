import {GlobalWorkerOptions, getDocument} from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {degrees, PDFDocument} from 'pdf-lib';
import type {Ink} from './session';

GlobalWorkerOptions.workerSrc = workerUrl;
export const pickerTypes = '.pdf,.jpg,.jpeg,.jfif,.png,.webp';
export async function openDeck(files:File[]) {
  if (!files.length) throw Error('Choose a PDF or slide images.');
  const ext = (f:File) => f.name.split('.').pop()?.toLowerCase();
  let bytes:Uint8Array<ArrayBuffer>;
  if (files.length === 1 && ext(files[0]) === 'pdf') {
    bytes = new Uint8Array(await files[0].arrayBuffer());
  } else {
    if (!files.every(f=>['jpg','jpeg','jfif','png','webp'].includes(ext(f) || ''))) throw Error('Open one PDF or a group of JPG, PNG or WebP images. Export other presentations as PDF first.');
    const pdf = await PDFDocument.create();
    for (const file of files) {
      const url = URL.createObjectURL(file);
      try {
        const img = new Image();
        img.src=url; await img.decode();
        const canvas=document.createElement('canvas');
        canvas.width=img.naturalWidth; canvas.height=img.naturalHeight;
        const ctx=canvas.getContext('2d')!;
        ctx.drawImage(img,0,0);
        const embedded=await pdf.embedPng(canvas.toDataURL('image/png'));
        pdf.addPage([embedded.width,embedded.height]).drawImage(embedded,{x:0,y:0});
      } finally { URL.revokeObjectURL(url); }
    }
    bytes = new Uint8Array(await pdf.save());
  }
  const task=getDocument({data:bytes.slice(),isEvalSupported:false,useSystemFonts:true});
  try {
    const doc=await task.promise;
    return {doc,bytes,title:files.length===1 ? files[0].name : files[0].name+' + '+(files.length-1)};
  } catch (error) {
    await task.destroy();
    if (error instanceof Error && error.name==='PasswordException') throw Error('Unlock the PDF and save an unprotected copy before opening it.');
    throw error;
  }
}
export type Deck = Awaited<ReturnType<typeof openDeck>>;
export type Stamp = {page:number; left:number; top:number; width:number; height:number; image:string};
export function signatureImage(strokes:Ink) {
  const canvas=document.createElement('canvas');
  canvas.width=900; canvas.height=300;
  const ctx=canvas.getContext('2d')!;
  ctx.strokeStyle=ctx.fillStyle='#202423'; ctx.lineWidth=4; ctx.lineCap=ctx.lineJoin='round';
  for (const stroke of strokes) {
    ctx.beginPath();
    stroke.forEach(([x,y],i)=>i ? ctx.lineTo(x*.9,y*.3) : ctx.moveTo(x*.9,y*.3));
    ctx.stroke();
    if (stroke.length===1) {ctx.beginPath(); ctx.arc(stroke[0][0]*.9,stroke[0][1]*.3,2,0,Math.PI*2);ctx.fill();}
  }
  return canvas.toDataURL('image/png');
}
export async function signedPdf(deck:Deck, stamps:Stamp[]) {
  const output=await PDFDocument.load(deck.bytes);
  for (const stamp of stamps) {
    const page=await deck.doc.getPage(stamp.page);
    const view=page.getViewport({scale:1});
    const [x,y]=view.convertToPdfPoint(stamp.left*view.width,(stamp.top+stamp.height)*view.height);
    const image=await output.embedPng(stamp.image);
    output.getPage(stamp.page-1).drawImage(image,{x,y,width:stamp.width*view.width/page.userUnit,
      height:stamp.height*view.height/page.userUnit,rotate:degrees(view.rotation)});
  }
  return new Blob([new Uint8Array(await output.save())],{type:'application/pdf'});
}

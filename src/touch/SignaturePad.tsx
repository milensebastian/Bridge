import {useEffect,useRef,useState} from 'react';
import type {PointerEvent} from 'react';
import type {Ink,Point} from './session';
export function InkView({ink}:{ink:Ink}) {
  return <svg viewBox="0 0 900 300" aria-hidden="true">{ink.map((s,i)=>s.length===1 ?
    <circle key={i} cx={s[0][0]*.9} cy={s[0][1]*.3} r="2" fill="currentColor"/> :
    <polyline key={i} points={s.map(([x,y])=>[x*.9,y*.3].join(',')).join(' ')} fill="none" stroke="currentColor" strokeWidth="4" strokeLinejoin="round" strokeLinecap="round"/>)}</svg>;
}
export function SignaturePad({send}:{send:(ink:Ink, confirmed:boolean)=>Promise<void>}) {
  const [ink,setInk]=useState<Ink>([]), [sent,setSent]=useState(false);
  const current=useRef<Ink>([]), pointer=useRef<number|null>(null), count=useRef(0);
  const timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  useEffect(()=>()=>clearTimeout(timer.current),[]);
  function change(value:Ink) {
    current.current=value; setInk(value); setSent(false);
    if (!timer.current) timer.current=setTimeout(()=>{timer.current=undefined;void send(current.current,false);},120);
  }
  function draw(e:PointerEvent<HTMLDivElement>,begin:boolean) {
    if (begin) {
      if (pointer.current!==null || current.current.length>=128 || e.button!==0) return;
      pointer.current=e.pointerId;e.currentTarget.setPointerCapture(e.pointerId);
    }
    if (pointer.current!==e.pointerId || count.current>=1200) return;
    const r=e.currentTarget.getBoundingClientRect();
    const coord=(n:number)=>Math.round(Math.max(0,Math.min(1,n))*1000);
    const point:Point=[coord((e.clientX-r.left)/r.width),coord((e.clientY-r.top)/r.height)];
    const last=current.current.at(-1)??[], prev=last.at(-1);
    if (!begin && prev && Math.abs(prev[0]-point[0])+Math.abs(prev[1]-point[1])<3) return;
    count.current++;
    change(begin ? [...current.current,[point]] : [...current.current.slice(0,-1),[...last,point]]);
  }
  return <div><p>Sign with your finger, mouse or stylus.</p><div className="signature-pad" aria-label="Signature drawing area"
    onPointerDown={e=>draw(e,true)} onPointerMove={e=>draw(e,false)} onLostPointerCapture={()=>{pointer.current=null;}}>
    <InkView ink={ink}/></div>
    <div className="file-actions"><button onClick={()=>{count.current=0;change([]);}} disabled={!ink.length}>Clear</button>
    <button className="primary" disabled={!ink.length || sent} onClick={async()=>{clearTimeout(timer.current);timer.current=undefined;
      try {await send(current.current,true);setSent(true);} catch { /* Parent displays the connection error. */ }
    }}>{sent?'Signature sent':'Use signature'}</button></div></div>;
}

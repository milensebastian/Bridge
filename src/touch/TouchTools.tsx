import {useEffect,useRef,useState} from 'react';
import type {RenderTask} from 'pdfjs-dist';
import {ArrowLeft,ArrowRight,Maximize,PenLine} from 'lucide-react';
import type {Bridge} from '../lib/bridge';
import {useSession} from '../store/session';
import {useTouch, step, type TouchMessage} from './session';
import {openDeck,pickerTypes,signatureImage,signedPdf,type Deck,type Stamp} from './document';
import {InkView,SignaturePad} from './SignaturePad';

type Props={bridge?:Bridge; ready:boolean; report:(s:string)=>void; visible:boolean};
export default function TouchTools({bridge,ready,report,visible}:Props) {
  const {local,remote,ink,confirmed,request,laser}=useTouch();
  const recipient = useSession(s => s.recipient);
  const [deck,setDeck]=useState<Deck|null>(null),[stamps,setStamps]=useState<Stamp[]>([]);
  const [loading,setLoading]=useState(false),[rendered,setRendered]=useState(''),[placing,setPlacing]=useState(false);
  const [drawing,setDrawing]=useState(false),[expanded,setExpanded]=useState(false);
  const chooser=useRef<HTMLInputElement>(null),canvas=useRef<HTMLCanvasElement>(null),stage=useRef<HTMLDivElement>(null);
  const swipe=useRef<{x:number;y:number}|null>(null);
  const [laserMode,setLaserMode]=useState(false),[scale,setScale]=useState(30);
  const lastMove=useRef(0);
  const drag=useRef<{index:number;dx:number;dy:number}|null>(null);
  useEffect(()=>{if(request)setDrawing(true);},[request]);
  const key=local ? local.id+'/'+local.page : '';
  async function send(m:TouchMessage) {
    if(!bridge || !ready) throw Error('Pair your devices and verify the symbols first.');
    await bridge.sendTouch(m);
  }
  function error(e:unknown) {report(e instanceof Error ? e.message : String(e));}
  useEffect(()=>{
    if (ready && bridge) void bridge.sendTouch({type:'touch',action:'slides',slides:local}).catch(error);
  },[bridge,ready,local,recipient]);
  useEffect(()=>{if(!ready){setDrawing(false);setPlacing(false);}},[ready]);
  useEffect(()=>()=>{void deck?.doc.destroy();},[deck]);
  useEffect(()=>{
    if(!deck || !local || !visible || !canvas.current) return;
    let cancelled=false, job:RenderTask|undefined;
    const element=canvas.current;
    setRendered('');
    void (async()=>{
      const page=await deck.doc.getPage(local.page);
      if(cancelled) return;
      const original=page.getViewport({scale:1});
      const viewport=page.getViewport({scale:Math.min(2200/original.width,2000/original.height)});
      element.width=Math.ceil(viewport.width); element.height=Math.ceil(viewport.height);
      job=page.render({canvasContext:element.getContext('2d')!,viewport});
      await job.promise;
      if(!cancelled)setRendered(key);
    })().catch(e=>{if(!cancelled)error(e);});
    return ()=>{cancelled=true;job?.cancel();};
  },[deck,key,visible]);
  useEffect(()=>{
    const fullscreen=()=>setExpanded(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange',fullscreen);
    return ()=>document.removeEventListener('fullscreenchange',fullscreen);
  },[]);
  function move(delta:-1|1) {
    if(local) step(local.id,delta);
    else if(remote && ready) void send({type:'touch',action:'step',id:remote.id,delta}).catch(error);
  }
  useEffect(()=>{
    const keydown=(e:KeyboardEvent)=>{
      if(!visible || (!local && !remote) || e.altKey || e.ctrlKey || e.metaKey || (e.target instanceof HTMLElement && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName))))return;
      if(e.key==='ArrowLeft' || e.key==='ArrowRight'){e.preventDefault();move(e.key==='ArrowRight'?1:-1);}
      if(e.key==='Escape'){setExpanded(false);setPlacing(false);}
    };
    window.addEventListener('keydown',keydown);return ()=>window.removeEventListener('keydown',keydown);
  },[visible,local,remote,ready,bridge]);
  async function load(files:File[]) {
    if(!files.length)return;
    setLoading(true);
    try {
      const next=await openDeck(files);
      setDeck(next);setStamps([]);setPlacing(false);
      useTouch.setState({local:{id:crypto.randomUUID(),title:next.title.slice(0,300),page:1,count:next.doc.numPages}});
    } catch(e){error(e);} finally{setLoading(false);}
  }
  const slides=local??remote;
  const download=(href:string,name:string)=>{const a=document.createElement('a');a.href=href;a.download=name;document.body.append(a);a.click();a.remove();};
  return <div hidden={!visible} className="clipboard-workspace touch-workspace" onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();if(!loading)void load(Array.from(e.dataTransfer.files));}}>
    <div className="tool-heading"><div><h2>Touch &amp; sign</h2><p>Present slides and sign documents with your paired device.</p></div></div>
    <input type="file" multiple hidden ref={chooser} accept={pickerTypes} onChange={e=>{const files=Array.from(e.target.files??[]);e.target.value='';void load(files);}}/>
    {!slides && <div className="file-drop"><p>Open slides here, then use your phone as the remote.</p><div className="file-actions">
      <button disabled={loading} onClick={()=>chooser.current?.click()}>{loading?'Opening…':'Open presentation'}</button></div>
      <small>PDF, JPG, PNG or WebP. For PowerPoint, Keynote and Google Slides, export as PDF.</small></div>}
    {slides && <div ref={stage} className={'present-stage'+(expanded?' expanded':'')}>
      <strong>{slides.title}</strong>
      {local && deck ? <div className="slide-area"><div className={'slide-sheet'+(placing?' placing':'')} onClick={e=>{
        if(!placing || !confirmed || rendered!==key) return;
        const r=e.currentTarget.getBoundingClientRect(), width=Math.min(scale/100,1.2*r.height/r.width), height=width*r.width/(3*r.height);
        const clamp=(value:number,max:number)=>Math.max(0,Math.min(max,value));
        setStamps(s=>[...s,{page:local.page,width,height,left:clamp((e.clientX-r.left)/r.width-width/2,1-width),
          top:clamp((e.clientY-r.top)/r.height-height/2,1-height),image:signatureImage(ink)}]);setPlacing(false);
      }}><canvas ref={canvas} aria-label={'Slide '+local.page}/>
        {laser && <i className="laser-dot" style={{left:laser[0]/10+'%',top:laser[1]/10+'%'}}/>}
        {rendered===key && stamps.map((stamp,index)=>stamp.page===local.page && <img key={index} draggable={false}
          src={stamp.image} alt="Placed signature" title="Drag to reposition" style={{left:stamp.left*100+'%',top:stamp.top*100+'%',width:stamp.width*100+'%',height:stamp.height*100+'%'}}
          onPointerDown={e=>{
            if(placing)return;
            const r=e.currentTarget.parentElement!.getBoundingClientRect();
            drag.current={index,dx:(e.clientX-r.left)/r.width-stamp.left,dy:(e.clientY-r.top)/r.height-stamp.top};
            e.currentTarget.setPointerCapture(e.pointerId);
          }} onLostPointerCapture={()=>{drag.current=null;}} onPointerMove={e=>{
            const d=drag.current;
            if(!d || d.index!==index || !e.currentTarget.hasPointerCapture(e.pointerId))return;
            const r=e.currentTarget.parentElement!.getBoundingClientRect();
            const left=Math.max(0,Math.min(1-stamp.width,(e.clientX-r.left)/r.width-d.dx));
            const top=Math.max(0,Math.min(1-stamp.height,(e.clientY-r.top)/r.height-d.dy));
            setStamps(prev=>prev.map((s,i)=>i===index?{...s,left,top}:s));
          }}/>)}
      </div></div> : laserMode && remote ? <div className="laser-pad" onPointerDown={e=>e.currentTarget.setPointerCapture(e.pointerId)} onPointerMove={e=>{
        if(!e.currentTarget.hasPointerCapture(e.pointerId) || performance.now()-lastMove.current<35)return;
        lastMove.current=performance.now();const rect=e.currentTarget.getBoundingClientRect();
        const n=(v:number)=>Math.round(Math.min(1,Math.max(0,v))*1000);
        void send({type:'touch',action:'laser',id:remote.id,point:[n((e.clientX-rect.left)/rect.width),n((e.clientY-rect.top)/rect.height)]}).catch(error);
      }} onLostPointerCapture={()=>void send({type:'touch',action:'laser',id:remote.id,point:null}).catch(error)}>Drag to point at the slide</div> : <div className="remote-swipe" onTouchStart={e=>{swipe.current={x:e.touches[0].clientX,y:e.touches[0].clientY};}} onTouchEnd={e=>{
        const start=swipe.current;swipe.current=null;if(!start)return;const dx=e.changedTouches[0].clientX-start.x;
        if(Math.abs(dx)>45 && Math.abs(dx)>Math.abs(e.changedTouches[0].clientY-start.y))move(dx<0?1:-1);
      }}>Swipe to change slides</div>}
      <div className="slide-nav"><button aria-label="Previous slide" disabled={slides.page<=1} onClick={()=>move(-1)}><ArrowLeft size={17}/></button>
      <span aria-live="polite">Slide {slides.page} of {slides.count}</span><button aria-label="Next slide" disabled={slides.page>=slides.count} onClick={()=>move(1)}><ArrowRight size={17}/></button>
      {!local && <button aria-pressed={laserMode} onClick={()=>setLaserMode(!laserMode)}>Laser</button>}
      {local && <button aria-label={expanded?'Exit presentation':'Present fullscreen'} onClick={async()=>{
        if(expanded){if(document.fullscreenElement)await document.exitFullscreen();setExpanded(false);}
        else {try{await stage.current?.requestFullscreen();}catch{/* Use the fixed viewport layout. */}setExpanded(true);}
      }}><Maximize size={16}/></button>}</div>
    </div>}
    {local && <div className="file-actions"><button disabled={loading} onClick={()=>chooser.current?.click()}>Change slides</button>
      <button onClick={()=>{setDeck(null);setStamps([]);setPlacing(false);setExpanded(false);useTouch.setState({local:null});}}>Close slides</button></div>}
    <section className="sign-section"><h3>Signature</h3>
    {!ready ? <p>Pair and verify both devices to sign.</p> : <>
      {local && <button onClick={()=>void send({type:'touch',action:'request-signature'}).then(()=>report('Signature pad opened on your paired device.')).catch(error)}>Sign on paired device</button>}
      <button aria-expanded={drawing} onClick={()=>setDrawing(!drawing)}><PenLine size={16}/>{drawing?'Close pad':'Draw signature'}</button>
      {drawing && <SignaturePad send={async(strokes,final)=>{try{await send({type:'touch',action:'ink',strokes,confirmed:final});}catch(e){error(e);if(final)throw e;}}}/>}
      {!!ink.length && <div><p>{confirmed?'Signature from your device':'Signing on your device…'}</p><div className="signature-preview"><InkView ink={ink}/></div>
        {confirmed && <div className="file-actions"><button onClick={()=>download(signatureImage(ink),'signature.png')}>Save PNG</button>
          {local && <button disabled={rendered!==key} onClick={()=>setPlacing(!placing)}>{placing?'Cancel placement':'Place on page'}</button>}</div>}
      </div>}
    </>}
    {placing && confirmed && <label className="stamp-size">Signature size <input type="range" min="10" max="65" value={scale} onChange={e=>setScale(Number(e.target.value))}/>Tap the page to place it.</label>}
    {!!stamps.length && deck && <div className="file-actions"><button onClick={()=>setStamps(s=>s.slice(0,-1))}>Undo placement</button>
      <button className="primary" onClick={async()=>{try{const url=URL.createObjectURL(await signedPdf(deck,stamps));
        download(url,deck.title.replace(/\.[^.]+$/,'')+'-signed.pdf');setTimeout(()=>URL.revokeObjectURL(url),60000);}catch(e){error(e);}}}>Save signed PDF</button></div>}
    </section></div>;
}

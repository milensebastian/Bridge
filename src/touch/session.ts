import {create} from 'zustand';

export type Point = [number,number];
export type Ink = Point[][];
export type Slides = {id:string; title:string; page:number; count:number};
export type TouchMessage =
  | {type:'touch'; action:'slides'; slides:Slides | null}
  | {type:'touch'; action:'request-signature'}
  | {type:'touch'; action:'laser'; id:string; point:Point|null}
  | {type:'touch'; action:'step'; id:string; delta:-1 | 1}
  | {type:'touch'; action:'ink'; strokes:Ink; confirmed:boolean};

type TouchState = {local:Slides|null; remote:Slides|null; ink:Ink; confirmed:boolean; request:number; laser:Point|null};
export const useTouch = create<TouchState>(()=>({local:null,remote:null,ink:[],confirmed:false,request:0,laser:null}));
export function resetTouch() { useTouch.setState({remote:null,ink:[],confirmed:false,request:0,laser:null}); }
export function step(id:string, delta:number) {
  const local = useTouch.getState().local;
  if (local?.id === id) useTouch.setState({local:{...local,page:Math.max(1,Math.min(local.count,local.page+delta))}});
}
export function receiveTouch(message:TouchMessage) {
  switch(message.action) {
    case 'slides': {
      const s = message.slides;
      if (s !== null && (!s || typeof s.id !== 'string' || s.id.length > 64 || typeof s.title !== 'string' || s.title.length > 300 ||
        !Number.isSafeInteger(s.count) || !Number.isSafeInteger(s.page) || s.page < 1 || s.page > s.count)) throw Error('Invalid presentation state.');
      useTouch.setState({remote:s});
      break;
    }
    case 'request-signature':
      useTouch.setState(s=>({request:s.request+1}));break;
    case 'laser':
      if (message.id===useTouch.getState().local?.id && (message.point===null || (Array.isArray(message.point) && message.point.length===2 && message.point.every(n=>Number.isInteger(n) && n>=0 && n<=1000)))) useTouch.setState({laser:message.point});
      break;
    case 'step':
      if (message.delta === -1 || message.delta === 1) step(message.id,message.delta);
      break;
    case 'ink': {
      const ink = message.strokes;
      if (!Array.isArray(ink) || ink.length > 128 || typeof message.confirmed !== 'boolean') throw Error('Invalid signature.');
      let n = 0;
      for (const stroke of ink) {
        if (!Array.isArray(stroke) || !stroke.length || (n+=stroke.length)>1200 || !stroke.every(p=>Array.isArray(p) && p.length===2 && p.every(v=>Number.isInteger(v) && v>=0 && v<=1000))) throw Error('Invalid signature points.');
      }
      useTouch.setState({ink,confirmed:message.confirmed && !!ink.length});
      break;
    }
    default: throw Error('Unknown presenter command.');
  }
}

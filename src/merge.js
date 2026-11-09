// Clearpage cloud snapshot reconciliation. Deliberately no last-write-wins.
// Every ambiguous simultaneous edit is preserved as an independent copy.
export const MAX_CLOUD_BYTES = 10 * 1024 * 1024;
export const MAX_PAGES = 5000;

export function canonical(value) {
  if(Array.isArray(value))return value.map(canonical);
  if(value && typeof value==='object'){
    const result={};
    for(const key of Object.keys(value).sort())result[key]=canonical(value[key]);
    return result;
  }
  return value;
}
export const equal=(a,b)=>JSON.stringify(canonical(a??null))===JSON.stringify(canonical(b??null));
const serial = x => JSON.stringify(canonical(x??null));
const entry = (snapshot,id) => {
  const note=snapshot.notes.find(n=>n.id===id);
  if(note)return {kind:'notes',note};
  const trash=snapshot.trash.find(n=>n.id===id);
  return trash?{kind:'trash',note:trash}:null;
};
const same=(a,b)=>serial(a)===serial(b);
const isText=(n)=>n && typeof n.id==='string' && n.id.length<=200
 && typeof n.title==='string' && n.title.length<=160
 && typeof n.text==='string' && n.text.length<=5000000;
export function validState(state) {
  if(!state||state.schema!==1||!Array.isArray(state.notes)||!Array.isArray(state.trash)
    ||state.notes.length<1||state.notes.length>MAX_PAGES||state.trash.length>MAX_PAGES)return false;
  const all=[...state.notes,...state.trash];
  const ids=new Set();
  for(const n of all){if(!isText(n)||ids.has(n.id))return false;ids.add(n.id);}
  return true;
}
export function toState(snapshot) {
  return {schema:1,notes:structuredClone(snapshot.notes),trash:structuredClone(snapshot.trash)};
}
export function isBlank(state){
  return state.notes.length===1 && state.trash.length===0 && !state.notes[0].title.trim() && !state.notes[0].text.trim();
}
const isMeaningful=n=>Boolean(n.title.trim()||n.text.trim());
function append(target,item) {
  if(!item)return;
  target[item.kind].push(structuredClone(item.note));
}
export function reconcile(base,local,remote,makeId=()=>crypto.randomUUID()) {
  // Baseline missing means local and remote both count as independent data.
  if(!base)base={schema:1,notes:[],trash:[]};
  if(!validState(local)||!validState(remote) || (base.notes.length && !validState(base)))throw Error('Invalid sync snapshot');
  const ids=new Set([...base.notes,...base.trash,...local.notes,...local.trash,...remote.notes,...remote.trash].map(n=>n.id));
  const result={schema:1,notes:[],trash:[]};
  let conflicts=0;
  for(const id of ids){
    const b=entry(base,id),x=entry(local,id),y=entry(remote,id);
    if(same(x,b)){append(result,y);continue;}
    if(same(y,b)||same(x,y)){append(result,x);continue;}
    // Two edits both changed the same entity. Remote owns the original ID,
    // while local content is never silently thrown away.
    append(result,y);
    if(x){
      const copied=structuredClone(x);
      copied.note.id=makeId();
      copied.note.title=(copied.note.title||'Untitled').slice(0,128)+' (conflict copy)';
      copied.note.updatedAt=new Date().toISOString();
      append(result,copied);conflicts++;
    }else if(y)conflicts++; // Local deletion versus remote edit: retain remote.
  }
  // The initial editor placeholder must not pollute an existing cloud workspace.
  const meaningfulActive=result.notes.filter(isMeaningful);
  if(meaningfulActive.length && result.notes.length>meaningfulActive.length)
    result.notes=meaningfulActive;
  if(!result.notes.length){
    const blank=local.notes.find(n=>!isMeaningful(n))||remote.notes.find(n=>!isMeaningful(n));
    result.notes=[blank?structuredClone(blank):{id:makeId(),title:'',text:'',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}];
  }
  if(result.notes.length>MAX_PAGES||result.trash.length>MAX_PAGES)throw Error('Sync page limit exceeded');
  if(new TextEncoder().encode(JSON.stringify(result)).byteLength>MAX_CLOUD_BYTES)throw Error('Cloud snapshot exceeds 10 MB; export a local backup');
  return {state:result,conflicts};
}

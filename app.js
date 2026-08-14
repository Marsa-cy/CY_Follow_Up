
/* Moved to the very top: must exist before any early-executing code
   (e.g. the DOMContentLoaded/initDebugLogUI check below) can reference it. */
const USERS_STORAGE_KEY='container_lookup_users_v1';
const AUTH_SESSION_KEY='container_lookup_session_v1';
const AUTH_PBKDF2_ITERATIONS=200000;

/* ══════════════════════════════════════════════════════════════════
   CLOUD SYNC (optional) — fill this in to enable multi-device access.
   Leave every value as '' to keep the app working exactly as before,
   fully offline, one device at a time. This uses ONLY Cloud Firestore,
   which stays on Firebase's free Spark plan — no billing/credit card
   needed, and Cloud Storage is not used at all.

   How to get these values:
   1. Go to https://console.firebase.google.com → Add project (free).
   2. Inside the project: Firestore Database → Create database
      (Start in test mode is fine to begin with).
   3. Project settings (gear icon) → General → "Your apps" → Add app → Web (</>)
      → copy the firebaseConfig object it gives you into the object below.
   4. Authentication → Sign-in method → enable "Anonymous"
      (this app only uses it internally to satisfy Firestore's security rules —
      your own Username/Password login screen is unaffected and unchanged).
   ══════════════════════════════════════════════════════════════════ */
const FIREBASE_CONFIG={
  apiKey:'AIzaSyBy4kwmKEfBLMoKAJ7Y0EQR8xcIuLWKjPc',
  authDomain:'cy-follow-up.firebaseapp.com',
  projectId:'cy-follow-up',
  storageBucket:'cy-follow-up.firebasestorage.app',
  messagingSenderId:'254364583792',
  appId:'1:254364583792:web:52fca527ebf0fc3ba0b1b5'
};
const FIREBASE_ENABLED=!!(FIREBASE_CONFIG.apiKey&&FIREBASE_CONFIG.projectId);
const SCHEMA_VERSION=1; // bump this if the shape of {DATA,KEYS,BUILD_INFO} ever changes structurally
const FS_CHUNK_SIZE=120000; // chars per chunk — kept well under Firestore's 1MiB doc limit even when the string is mostly Arabic/multi-byte UTF-8, which can be 2-3x the JS character count once encoded
let fbDb=null,fbReady=false,lastFirebaseError=null;
/* ── Real Firebase Authentication layer ──
   Every visitor still gets an anonymous Firebase session on load (needed to read the
   one-time legacy password hash during migration). The moment someone signs in through
   the app's own username/password form and that check passes, we escalate them to a
   REAL Firebase Auth account (email + the password they just typed) — silently creating
   that account on their first post-upgrade login ("lazy migration"), signing straight
   into it on every login after that. Firestore rules can then require
   `sign_in_provider != 'anonymous'` for anything sensitive, closing the anonymous-access
   gap flagged in the security audit. A secondary, unnamed-free app instance is used for
   *creating* other people's accounts (adding a user, setting up the controller) so that
   doing so never signs the controller themselves out of their own session — the client
   SDK signs in as whichever account it just created, which would otherwise happen. */
let fbSecondaryApp=null;
const CONTROLLER_AUTH_EMAIL='controller@container-lookup.internal';
function secondaryAuth(){
  if(!fbSecondaryApp)fbSecondaryApp=firebase.initializeApp(FIREBASE_CONFIG,'secondary');
  return fbSecondaryApp.auth();
}
function realAuthEmailFor(username,email){
  const trimmed=String(email||'').trim();
  if(!trimmed||!trimmed.includes('@'))return null; // no usable email on file — this account can't be escalated to real auth yet
  const key=userKey(username);
  const at=trimmed.indexOf('@'),local=trimmed.slice(0,at),domain=trimmed.slice(at+1);
  if(local.includes(`+${key}`))return trimmed; // already alias-tagged
  return `${local}+${key}@${domain}`;
}
async function ensureRealAuthSession(email,password){
  if(!FIREBASE_ENABLED||!fbReady)return 'skipped';
  if(!email)return 'no-email';
  try{
    await firebase.auth().signInWithEmailAndPassword(email,password);
    return 'signed-in';
  }catch(signInErr){
    // Modern Firebase Auth deliberately returns the same generic
    // 'auth/invalid-credential' whether the account doesn't exist yet or the
    // password is wrong (this replaced the old, more specific
    // 'auth/user-not-found' / 'auth/wrong-password' codes, to stop this exact
    // kind of check from being used to enumerate valid emails). So instead of
    // branching on the sign-in error code, just try creating the account —
    // if it already exists, creation itself fails distinctly and clearly.
    try{
      await firebase.auth().createUserWithEmailAndPassword(email,password);
      return 'migrated';
    }catch(createErr){
      if(createErr.code==='auth/email-already-in-use'){
        throw new Error('Your password was recently reset — check for a password-reset email, or ask the controller to send a new one.');
      }
      console.error('Real-auth escalation failed',signInErr,createErr);
      return 'error';
    }
  }
}
async function createRealAuthAccount(email,password){
  if(!FIREBASE_ENABLED||!fbReady||!email)return null;
  const aux=secondaryAuth();
  try{
    const cred=await aux.createUserWithEmailAndPassword(email,password);
    await aux.signOut();
    return cred;
  }catch(err){
    await aux.signOut().catch(()=>{});
    if(err.code==='auth/email-already-in-use')return 'exists';
    throw err;
  }
}
function showCloudDiagnostics(){
  const lines=[
    `Firebase config filled in: ${FIREBASE_ENABLED?'Yes':'No — apiKey/projectId are blank in this file'}`,
    FIREBASE_ENABLED?`Project ID in this file: ${FIREBASE_CONFIG.projectId}`:'',
    `Connected right now: ${fbReady?'Yes ✅':'No'}`,
    lastFirebaseError?`Last error: ${lastFirebaseError}`:(FIREBASE_ENABLED&&!fbReady?'Still connecting, or no error was recorded.':'')
  ].filter(Boolean).join('\n');
  alert(lines);
}
document.querySelectorAll('.cloud-status-badge').forEach(el=>{el.style.cursor='pointer';el.title='Tap for connection details';el.addEventListener('click',showCloudDiagnostics)});
let USERS_CACHE={},ADMIN_CACHE=null,lastSystemUpdateMs=null;

function updateCloudStatusBadge(){
  const state=!FIREBASE_ENABLED?'off':(fbReady?'on':'error');
  const label=state==='off'?'⚪ Cloud sync off':state==='on'?'🟢 Cloud connected':'🔴 Cloud offline';
  document.querySelectorAll('.cloud-status-badge').forEach(el=>{el.textContent=label;el.dataset.state=state});
}
async function initFirebase(){
  if(!FIREBASE_ENABLED){updateCloudStatusBadge();return false}
  try{
    firebase.initializeApp(FIREBASE_CONFIG);
    fbDb=firebase.firestore();
    // Wait for Firebase to finish restoring any session it already has persisted
    // (real login OR anonymous) before deciding whether to sign in anonymously.
    // Calling signInAnonymously() unconditionally here was silently replacing an
    // already-real, migrated session with a fresh anonymous one on every page
    // reload — invisible under the old rules, but a hard permission-denied
    // ("Cloud offline") under the stricter ones, since anonymous sessions can no
    // longer read the main data collections.
    const restoredUser=await new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(new Error('Connection timed out after 8s — the network may be blocking Google\'s servers (try switching between WiFi and mobile data, or disabling any VPN).')),8000);
      const unsub=firebase.auth().onAuthStateChanged(user=>{clearTimeout(timeout);unsub();resolve(user)},err=>{clearTimeout(timeout);unsub();reject(err)});
    });
    if(!restoredUser)await firebase.auth().signInAnonymously();
    fbReady=true;
    updateCloudStatusBadge();
    return true;
  }catch(err){console.error('Cloud sync could not start — continuing in local-only mode.',err);fbReady=false;lastFirebaseError=err?.message||String(err);updateCloudStatusBadge();return false}
}
function waitForFirebaseReady(){
  if(!FIREBASE_ENABLED||!fbReady)return Promise.resolve();
  return new Promise(resolve=>{
    let usersDone=false,adminDone=false,settled=false;
    const finish=()=>{if(settled)return;if(usersDone&&adminDone){settled=true;resolve()}};
    fbDb.collection('users').onSnapshot(snap=>{
      const next={},legacy=[];
      snap.forEach(doc=>{
        const data=doc.data();
        if(data.salt&&data.hash){legacy.push({id:doc.id,salt:data.salt,hash:data.hash})}
        const{salt,hash,...publicFields}=data;
        next[doc.id]=publicFields;
      });
      USERS_CACHE=next;
      if(legacy.length)migrateLegacySecrets('users','userSecrets',legacy);
      if(!usersDone){usersDone=true;finish()}
      refreshAuthScreenMode?.();
      if(document.getElementById('usersOverlay')?.classList.contains('open'))renderUsersList?.();
    },err=>{console.error('users sync error',err);lastFirebaseError=err?.message||String(err);fbReady=false;updateCloudStatusBadge();if(!usersDone){usersDone=true;finish()}});
    fbDb.collection('admin').doc('controller').onSnapshot(doc=>{
      if(doc.exists){
        const data=doc.data();
        if(data.salt&&data.hash)migrateLegacySecrets('admin','adminSecrets',[{id:'controller',salt:data.salt,hash:data.hash}]);
        const{salt,hash,...publicFields}=data;
        ADMIN_CACHE=publicFields;
      }else ADMIN_CACHE=null;
      if(!adminDone){adminDone=true;finish()}
    },err=>{console.error('controller sync error',err);lastFirebaseError=err?.message||String(err);fbReady=false;updateCloudStatusBadge();if(!adminDone){adminDone=true;finish()}});
    setTimeout(()=>{if(!settled){settled=true;resolve()}},4000);
  });
}
/* One-time self-healing: older versions of this file stored the password
   hash/salt directly inside the public users/admin documents. The first
   time any device with the updated file sees a doc in that old shape, it
   quietly moves the secret into the separate *Secrets collection and
   strips it from the public one — closing the exposure without anyone
   needing to do anything. */
async function migrateLegacySecrets(publicCollection,secretCollection,items){
  if(!FIREBASE_ENABLED||!fbReady)return;
  try{
    const batch=fbDb.batch();
    items.forEach(item=>{
      batch.set(fbDb.collection(secretCollection).doc(item.id),{salt:item.salt,hash:item.hash});
      batch.update(fbDb.collection(publicCollection).doc(item.id),{salt:firebase.firestore.FieldValue.delete(),hash:firebase.firestore.FieldValue.delete()});
    });
    await batch.commit();
  }catch(err){console.error('Legacy credential migration failed (will retry next load)',err)}
}
function listenSystemData(){
  if(!FIREBASE_ENABLED||!fbReady)return;
  fbDb.collection('system').doc('current').onSnapshot(doc=>{
    if(!doc.exists)return;
    const meta=doc.data(),ts=meta.updatedAt?.toMillis?.()||0;
    if(lastSystemUpdateMs===null){lastSystemUpdateMs=ts;return}
    if(ts===lastSystemUpdateMs)return;
    lastSystemUpdateMs=ts;
    showCloudUpdateBanner(meta);
  },err=>{console.error('system data sync error',err);lastFirebaseError=err?.message||String(err);fbReady=false;updateCloudStatusBadge()});
}
function showCloudUpdateBanner(meta){
  const bar=document.getElementById('cloudUpdateBar');if(!bar)return;
  const who=meta.updatedBy?` by ${meta.updatedBy}`:'';
  document.getElementById('cloudUpdateText').textContent=`🔄 New data was uploaded${who} — refresh to see it.`;
  bar.classList.add('show');
}
/* ── Sticky controller announcement bar — visible to everyone signed in ── */
const ANNOUNCEMENT_LOCAL_KEY='container_lookup_announcement_v1';
const ANNOUNCEMENT_DISMISS_KEY='container_lookup_announcement_dismissed_v1';
let announcementListenerStarted=false;
function listenAnnouncement(){
  if(!FIREBASE_ENABLED||!fbReady){renderAnnouncementBar(loadAnnouncementLocal());return}
  if(announcementListenerStarted)return;
  announcementListenerStarted=true;
  fbDb.collection('announcements').doc('current').onSnapshot(doc=>{
    const data=doc.exists?doc.data():null;
    renderAnnouncementBar(data);
    renderAnnouncementEditor(data);
  },err=>console.error('announcement sync error',err));
}
function loadAnnouncementLocal(){try{return JSON.parse(localStorage.getItem(ANNOUNCEMENT_LOCAL_KEY)||'null')}catch(_){return null}}
function renderAnnouncementBar(data){
  const bar=document.getElementById('announcementBar');if(!bar)return;
  const text=String(data?.text||'').trim();
  if(!text){bar.style.display='none';return}
  const stamp=`${text}|${data?.updatedAt?.toMillis?.()||data?.updatedAt||''}`;
  let dismissed=null;try{dismissed=sessionStorage.getItem(ANNOUNCEMENT_DISMISS_KEY)}catch(_){}
  if(dismissed===stamp){bar.style.display='none';return}
  document.getElementById('announcementText').textContent=text;
  bar.dataset.stamp=stamp;
  bar.style.display='flex';
}
function renderAnnouncementEditor(data){
  const input=document.getElementById('announcementInput'),meta=document.getElementById('announcementMeta');
  if(!input)return;
  if(document.activeElement!==input)input.value=data?.text||'';
  if(meta)meta.textContent=data?.text?`Last published${data.updatedBy?` by ${data.updatedBy}`:''}${data.updatedAt?.toDate?` · ${data.updatedAt.toDate().toLocaleString('en-GB')}`:''}`:'No announcement currently live';
}
async function publishAnnouncement(text){
  const trimmed=String(text||'').trim();
  const by=storageGet(AUTH_SESSION_KEY)||'controller';
  if(FIREBASE_ENABLED&&fbReady){
    await fbDb.collection('announcements').doc('current').set({text:trimmed,updatedBy:by,updatedAt:firebase.firestore.FieldValue.serverTimestamp()});
  }else{
    const data={text:trimmed,updatedBy:by,updatedAt:new Date().toISOString()};
    localStorage.setItem(ANNOUNCEMENT_LOCAL_KEY,JSON.stringify(data));
    renderAnnouncementBar(data);renderAnnouncementEditor(data);
  }
  auditLog(trimmed?'publish_announcement':'clear_announcement',trimmed.slice(0,80));
}
function dismissAnnouncement(){
  const bar=document.getElementById('announcementBar');if(!bar)return;
  try{sessionStorage.setItem(ANNOUNCEMENT_DISMISS_KEY,bar.dataset.stamp||'')}catch(_){}
  bar.style.display='none';
}
let LAST_CLOUD_META=null;
function uint8ToBase64(bytes){
  let binary='';
  const chunkSize=8192;
  for(let i=0;i<bytes.length;i+=chunkSize)binary+=String.fromCharCode.apply(null,bytes.subarray(i,i+chunkSize));
  return btoa(binary);
}
function base64ToUint8(b64){
  const binary=atob(b64);
  const bytes=new Uint8Array(binary.length);
  for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
  return bytes;
}
async function pullLatestSystemData(){
  if(!FIREBASE_ENABLED||!fbReady)return false;
  const doc=await fbDb.collection('system').doc('current').get({source:'server'});
  if(!doc.exists)return false;
  const meta=doc.data(),count=meta.chunkCount||0;
  if(!count)return false;
  const snaps=await Promise.all(Array.from({length:count},(_,i)=>fbDb.collection('systemDataChunks').doc(String(i)).get({source:'server'})));
  const joined=snaps.map(s=>s.exists?(s.data().chunk||''):'').join('');
  let payloadStr;
  if(meta.compressed&&typeof pako!=='undefined'){
    dlog?.(`pullLatestSystemData: decompressing ${joined.length} base64 chars…`);
    payloadStr=pako.inflate(base64ToUint8(joined),{to:'string'});
  }else{
    payloadStr=joined; // legacy, uncompressed chunk format
  }
  const payload=JSON.parse(payloadStr);
  if(payload.schemaVersion&&payload.schemaVersion>SCHEMA_VERSION){
    console.error(`Cloud data is schema v${payload.schemaVersion}, this app build only understands up to v${SCHEMA_VERSION} — some fields may not display correctly until the app is updated.`);
    dlog?.(`⚠️ Cloud schema v${payload.schemaVersion} is newer than this build (v${SCHEMA_VERSION})`);
  }
  lastSystemUpdateMs=meta.updatedAt?.toMillis?.()||Date.now();
  LAST_CLOUD_META={updatedBy:meta.updatedBy||null,updatedAt:lastSystemUpdateMs};
  updateCloudMetaBadge();
  idbSet(IDB_DATA_KEY,payload);
  return payload;
}
function updateCloudMetaBadge(){
  const el=document.getElementById('cloudMetaNote');if(!el)return;
  if(!LAST_CLOUD_META){el.textContent='';return}
  const when=new Date(LAST_CLOUD_META.updatedAt).toLocaleString('en-GB');
  el.textContent=`Cloud data last updated${LAST_CLOUD_META.updatedBy?' by '+LAST_CLOUD_META.updatedBy:''} — ${when}`;
}
async function persistSystemData(){
  dlog('persistSystemData: start');
  await idbSet(IDB_DATA_KEY,{DATA,KEYS,BUILD_INFO});
  dlog('persistSystemData: saved locally to IndexedDB');
  if(!FIREBASE_ENABLED){dlog('persistSystemData: FIREBASE_ENABLED is false, stopping here');return}
  if(!fbReady){dlog('persistSystemData: fbReady is false, stopping here');showToast('⚠️ Saved on this device only — the cloud connection is not active (check Cloud status in the header)');return}
  try{
    const payloadStr=JSON.stringify({schemaVersion:SCHEMA_VERSION,DATA,KEYS,BUILD_INFO});
    dlog(`persistSystemData: payload built, ${payloadStr.length} chars`);
    let uploadStr=payloadStr,compressed=false;
    if(typeof pako!=='undefined'){
      try{
        const deflated=pako.deflate(payloadStr);
        uploadStr=uint8ToBase64(deflated);
        compressed=true;
        dlog(`persistSystemData: compressed ${payloadStr.length} → ${uploadStr.length} chars (${Math.round(100-uploadStr.length/payloadStr.length*100)}% smaller)`);
      }catch(err){console.error('Compression failed, uploading uncompressed',err);uploadStr=payloadStr;compressed=false}
    }
    const chunks=[];
    for(let i=0;i<uploadStr.length;i+=FS_CHUNK_SIZE)chunks.push(uploadStr.slice(i,i+FS_CHUNK_SIZE));
    dlog(`persistSystemData: split into ${chunks.length} chunks`);
    // Guard against any single chunk being too close to Firestore's 1MiB document limit
    // once encoded as UTF-8 (Arabic/multi-byte text can be 2-3x the JS character count).
    const oversize=chunks.find(c=>new Blob([c]).size>900000);
    if(oversize)throw new Error(`A data chunk is ${(new Blob([oversize]).size/1024).toFixed(0)}KB after encoding — too close to Firestore's 1MB document limit. Reduce FS_CHUNK_SIZE and try again.`);
    dlog('persistSystemData: chunk size check passed, reading old doc…');
    const oldDoc=await fbDb.collection('system').doc('current').get({source:'server'});
    const oldCount=oldDoc.exists?(oldDoc.data().chunkCount||0):0;
    dlog(`persistSystemData: old chunkCount=${oldCount}, writing ${chunks.length} new chunks…`);
    // Fire every chunk write in parallel and track real per-chunk completion for the
    // progress bar — this is bandwidth-bound (see the compression change above), so
    // batching the requests doesn't change total time, only how granular progress looks.
    let chunksDone=0;
    updateSyncProgress(0,chunks.length);
    await Promise.all(chunks.map((chunk,i)=>
      fbDb.collection('systemDataChunks').doc(String(i)).set({chunk,index:i}).then(()=>{
        chunksDone++;
        updateSyncProgress(chunksDone,chunks.length);
      })
    ));
    dlog(`persistSystemData: all ${chunks.length}/${chunks.length} chunks written`);
    if(chunks.length<oldCount){
      dlog(`persistSystemData: cleaning up ${oldCount-chunks.length} leftover old chunks`);
      const cleanupBatch=fbDb.batch();
      for(let i=chunks.length;i<oldCount;i++)cleanupBatch.delete(fbDb.collection('systemDataChunks').doc(String(i)));
      await cleanupBatch.commit();
    }
    dlog('persistSystemData: writing system/current metadata doc…');
    await fbDb.collection('system').doc('current').set({
      updatedAt:firebase.firestore.FieldValue.serverTimestamp(),
      updatedBy:storageGet(AUTH_SESSION_KEY)||'a user',
      chunkCount:chunks.length,
      compressed,
      movementFileName:selectedSourceFiles.movement?.name||null,
      managementFileName:selectedSourceFiles.management?.name||null
    });
    dlog('persistSystemData: metadata doc write returned, verifying…');
    const confirm=await fbDb.collection('system').doc('current').get({source:'server'});
    const confirmMeta=confirm.data();
    const confirmedAtMs=confirmMeta?.updatedAt?.toMillis?.()||0;
    dlog(`persistSystemData: verify read → chunkCount=${confirmMeta?.chunkCount}, updatedAt=${new Date(confirmedAtMs).toISOString()}`);
    if((confirmMeta?.chunkCount||0)!==chunks.length)throw new Error(`Cloud write did not verify (expected ${chunks.length} chunks, server shows ${confirmMeta?.chunkCount||0}) — please try again.`);
    LAST_CLOUD_META={updatedBy:confirmMeta.updatedBy||null,updatedAt:confirmedAtMs};
    updateCloudMetaBadge();
    dlog('persistSystemData: ✅ SUCCESS — verified on server');
    showToast('☁️ Synced — other signed-in devices will see this update');
  }catch(err){
    dlog(`persistSystemData: ❌ FAILED — ${err?.code||''} ${err?.message||err}`);
    updateSyncProgress(0,0);
    console.error('Cloud sync failed',err);
    const detail=err?.code?`${err.code}: ${err.message||''}`:(err?.message||'unknown error');
    showToast(`⚠️ Saved on this device only — cloud upload failed (${detail})`);
    alert(`Cloud sync failed:\n\n${detail}\n\nYour data was saved on this device only. Please screenshot this message.`);
  }
}

/* ── Persisted dataset (survives page refresh, cleared on logout) ──
   The parsed container data is cached in IndexedDB on this device only,
   so a refresh doesn't force re-selecting the two Excel files. Logging
   out clears it immediately. */
const IDB_NAME='container_lookup_store_v1',IDB_STORE='kv',IDB_DATA_KEY='systemData';
function idbOpen(){
  return new Promise((resolve,reject)=>{
    if(!window.indexedDB)return reject(new Error('IndexedDB unavailable'));
    const req=indexedDB.open(IDB_NAME,1);
    req.onupgradeneeded=()=>{if(!req.result.objectStoreNames.contains(IDB_STORE))req.result.createObjectStore(IDB_STORE)};
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });
}
async function idbSet(key,value){
  try{
    const db=await idbOpen();
    return await new Promise((resolve,reject)=>{
      const tx=db.transaction(IDB_STORE,'readwrite');
      tx.objectStore(IDB_STORE).put(value,key);
      tx.oncomplete=()=>resolve(true);tx.onerror=()=>reject(tx.error);
    });
  }catch(err){console.error('Could not save data locally',err);return false}
}
async function idbGet(key){
  try{
    const db=await idbOpen();
    return await new Promise((resolve,reject)=>{
      const tx=db.transaction(IDB_STORE,'readonly'),req=tx.objectStore(IDB_STORE).get(key);
      req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
    });
  }catch(err){console.error('Could not read saved data',err);return null}
}
async function idbDelete(key){
  try{
    const db=await idbOpen();
    return await new Promise((resolve,reject)=>{
      const tx=db.transaction(IDB_STORE,'readwrite');
      tx.objectStore(IDB_STORE).delete(key);
      tx.oncomplete=()=>resolve(true);tx.onerror=()=>reject(tx.error);
    });
  }catch(err){console.error('Could not clear saved data',err);return false}
}
async function tryRestorePersistedData(){
  let saved=null,fromCloud=false;
  if(FIREBASE_ENABLED&&fbReady){
    try{saved=await pullLatestSystemData();if(saved)fromCloud=true}
    catch(err){console.error('Cloud fetch failed, falling back to the local copy on this device',err)}
  }
  if(!saved)saved=await idbGet(IDB_DATA_KEY);
  if(!saved||!saved.DATA||!Object.keys(saved.DATA).length)return false;
  DATA=saved.DATA;KEYS=saved.KEYS&&saved.KEYS.length?saved.KEYS:Object.keys(DATA).sort();BUILD_INFO=saved.BUILD_INFO||BUILD_INFO;
  SEARCH_INDEX=KEYS.map(buildSearchIndexRecord);
  systemDataLoaded=true;
  document.body.classList.remove('auth-locked','sources-locked');
  initializeLoadedSystem();
  listenSystemData();listenYardData();listenAnnouncement();
  showToast(fromCloud?'☁️ Synced from the cloud':'✅ Restored your previous session — no need to re-select the Excel files');
  return true;
}

let DATA={};
let BUILD_INFO={
  generated_at:null,
  source_files:[],
  cy_report_date:null,
  movements:0,
  archive:0,
  customers:0,
  will_back:0,
  cy_records:0,
  containers:0,
  pivot_final_seal:0,
  pivot_half_seal:0,
  pivot_local:0,
  pivot_total:0,
  detention_formula:'calendar_days_non_negative'
};

let KEYS=[];
const input=document.getElementById('searchInput'),clearBtn=document.getElementById('clearBtn'),searchBtn=document.getElementById('searchBtn'),suggestBox=document.getElementById('suggestions'),resultDiv=document.getElementById('result'),emptyState=document.getElementById('emptyState'),notFound=document.getElementById('notFound'),batchToggleBtn=document.getElementById('batchToggleBtn'),batchPanel=document.getElementById('batchPanel'),batchInput=document.getElementById('batchInput'),batchRunBtn=document.getElementById('batchRunBtn'),batchClearBtn=document.getElementById('batchClearBtn'),batchCounter=document.getElementById('batchCounter'),deadlineAlerts=document.getElementById('deadlineAlerts');
let currentContainer=null,currentBatchContainers=[],currentBatchContext=null;
function normalizeText(v){return String(v??'').trim().replace(/\s+/g,' ')}
function safeHistoryReplace(url){try{history.replaceState({},'',url)}catch(_){}}
function normalizeContainer(v){return normalizeText(v).toUpperCase().replace(/\s+/g,'').replace(/[^A-Z0-9*]/g,'')}
function showSkeletonOverlay(text){const el=document.getElementById('skeletonOverlay');if(el)el.style.display='block';const t=document.getElementById('skeletonStatusText');if(t&&text)t.textContent=text}
function hideSkeletonOverlay(){const el=document.getElementById('skeletonOverlay');if(el)el.style.display='none'}
function updateSyncProgress(done,total){
  const wrap=document.getElementById('syncProgressWrap'),bar=document.getElementById('syncProgressBar'),label=document.getElementById('syncProgressLabel');
  if(!wrap)return;
  if(total<=0){wrap.style.display='none';return}
  wrap.style.display='block';
  const pct=Math.round(done/total*100);
  if(bar)bar.style.width=pct+'%';
  if(label)label.textContent=`Uploading… ${done}/${total} chunks (${pct}%)`;
  if(done>=total)setTimeout(()=>{wrap.style.display='none'},1200);
}
function iso6346CheckDigitValid(cntr){
  const c=String(cntr||'').toUpperCase();
  if(!/^[A-Z]{4}\d{7}$/.test(c))return null; // not a standard-shaped container number — nothing to check
  const letterValue=ch=>{
    const map='0123456789A?BCDEFGHIJK?LMNOPQRSTU?VWXYZ';
    const idx=map.indexOf(ch);
    let v=idx>=0?idx:0;
    while(v>=11&&(v%11===0))v++; // 11, 22, 33 are skipped in the ISO 6346 letter table
    return v;
  };
  let sum=0;
  for(let i=0;i<10;i++){
    const ch=c[i];
    const v=/[0-9]/.test(ch)?Number(ch):letterValue(ch);
    sum+=v*Math.pow(2,i);
  }
  const expected=sum%11%10;
  return expected===Number(c[10]);
}
function debounce(fn,ms){let t;return(...args)=>{clearTimeout(t);t=setTimeout(()=>fn(...args),ms)}}
function esc(v){return String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;')}
function hasValue(v){return v!==null&&v!==undefined&&v!==''}
function hasRecord(o){return !!o&&Object.values(o).some(hasValue)}
function normStatus(v){return normalizeText(v).toUpperCase().replace('OUT OF SERVISE','OUT OF SERVICE')}
function parseDate(v){if(!hasValue(v))return null;const d=new Date(v);return Number.isNaN(d.getTime())?null:d}
function fmtDate(v){const d=parseDate(v);return d?d.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}):(hasValue(v)?esc(v):'<span class="null">—</span>')}
function fmtDatePlain(v){const d=parseDate(v);return d?d.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}):(hasValue(v)?String(v):'')}
function fmtTime(v){const d=parseDate(v);return d?d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}):'—'}
function fmtDuration(minutes){if(!hasValue(minutes)||Number.isNaN(Number(minutes)))return'—';let total=Math.max(0,Math.round(Number(minutes))),days=Math.floor(total/1440),hours=Math.floor((total%1440)/60),mins=total%60;return(days?days+'d ':'')+(hours?hours+'h ':'')+mins+'m'}
function dateOnlyMs(v){if(!hasValue(v))return null;const m=String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);if(m)return Date.UTC(Number(m[1]),Number(m[2])-1,Number(m[3]));const d=parseDate(v);return d?Date.UTC(d.getFullYear(),d.getMonth(),d.getDate()):null}
let SYSTEM_SNAPSHOT_MS=null;
function systemAsOfMs(){return SYSTEM_SNAPSHOT_MS!==null?SYSTEM_SNAPSHOT_MS:todayDateOnlyMs()}
function systemAsOfLabel(){return fmtDatePlain(BUILD_INFO.system_opened_at||new Date())}
function detentionInfo(cy){
  if(!cy)return{days:null,status:'NO DATA',detail:'No CY Management record',basis:''};
  const deadline=dateOnlyMs(cy.deadline);
  if(deadline===null)return{days:null,status:'NO DEADLINE',detail:'Deadline to POL is not available',basis:''};
  const enteredPort=hasValue(cy.port_gate_in),portMs=enteredPort?dateOnlyMs(cy.port_gate_in):null;
  // If the container has already gated in to the port, detention is fixed and based on that
  // actual entry date vs. the deadline. If it hasn't gated in yet, we measure against today
  // (the system's open date) so the figure keeps counting up until it does gate in.
  const refMs=enteredPort&&portMs!==null?portMs:systemAsOfMs();
  const refLabel=enteredPort&&portMs!==null?fmtDatePlain(cy.port_gate_in):systemAsOfLabel();
  const basis=enteredPort?'Deadline to POL − Gate In to Port':'Deadline to POL − System Open Date (not yet gated in)';
  // Sign convention: positive = still within the deadline (days to spare). Negative = overdue
  // (in detention), and the magnitude is how many days over the deadline it is/was.
  const diff=Math.round((deadline-refMs)/86400000);
  if(diff<0){
    const overdue=Math.abs(diff);
    const detail=enteredPort
      ?`Gated in to the port ${overdue} day${overdue===1?'':'s'} after the deadline (${refLabel})`
      :`${overdue} day${overdue===1?'':'s'} overdue as of ${refLabel} — has not gated in to the port yet`;
    return{days:diff,status:`${diff}`,detail,basis};
  }
  if(diff===0){
    const detail=enteredPort?`Gated in to the port exactly on the deadline (${refLabel}) — DONE`:`Deadline is today, ${refLabel}`;
    return{days:0,status:enteredPort?'DONE':'DUE TODAY',detail,basis};
  }
  const detail=enteredPort
    ?`Gated in to the port ${diff} day${diff===1?'':'s'} before the deadline (${refLabel}) — DONE`
    :`${diff} day${diff===1?'':'s'} remaining as of ${refLabel}`;
  return{days:diff,status:enteredPort?'DONE':'NO DETENTION',detail,basis};
}
function detentionHtml(cy){const x=detentionInfo(cy);if(x.days===null)return`<span class="detention-wrap"><span class="detention-days detention-unknown">—</span><span class="detention-note">${esc(x.detail)}</span></span>`;const cls=x.days<0?'detention-active':'detention-zero';const label=x.days<0?`−${Math.abs(x.days)} day${Math.abs(x.days)===1?'':'s'}`:`+${x.days} day${x.days===1?'':'s'}`;return`<span class="detention-wrap"><span class="detention-days ${cls}">${label}</span><span class="detention-note"><strong>${esc(x.status)}</strong> · ${esc(x.detail)}</span></span>`}
function detentionPlain(cy){const x=detentionInfo(cy);return x.days===null?'':x.days}

const DEADLINE_ALERT_WINDOW_DAYS=6;
let deadlineAlertContainers=[];
function todayDateOnlyMs(){const d=new Date();return Date.UTC(d.getFullYear(),d.getMonth(),d.getDate())}
function deadlineAlertLevel(days){
  if(days<0){const overdue=Math.abs(days);return{key:'overdue',label:`${overdue} DAY${overdue===1?'':'S'} OVERDUE`,cls:'deadline-overdue'}}
  if(days===0)return{key:'due',label:'DUE TODAY',cls:'deadline-due'};
  if(days<=2)return{key:'urgent',label:`${days} DAY${days===1?'':'S'} LEFT`,cls:'deadline-urgent'};
  if(days<=4)return{key:'warning',label:`${days} DAYS LEFT`,cls:'deadline-warning'};
  return{key:'upcoming',label:`${days} DAYS LEFT`,cls:'deadline-upcoming'}
}
function isActualGateOut(v){return !blankish(v)}
function hasGateOutInEitherSheet(d){
  if(!d)return false;
  const records=[];
  if(d.cy)records.push(d.cy);
  if(d.archive)records.push(d.archive);
  if(d.will_back)records.push(d.will_back);
  records.push(...(d.cy_records||[]),...(d.archive_records||[]),...(d.will_back_records||[]));
  return records.some(r=>r&&isActualGateOut(r.gate_out));
}
function getDeadlineAlerts(){
  if(!DATA)return[];
  const today=systemAsOfMs(),best=new Map();
  for(const cntr of KEYS){
    const d=DATA[cntr]||{};
    // Exclude the whole container when Gate Out exists in either source workbook.
    if(hasGateOutInEitherSheet(d))continue;
    const records=(d.cy_records&&d.cy_records.length?d.cy_records:(d.cy?[d.cy]:[]));
    for(const cy of records){
      if(!cy||!hasValue(cy.deadline))continue;
      const deadline=dateOnlyMs(cy.deadline);if(deadline===null)continue;
      const days=Math.round((deadline-today)/86400000);
      // Include every overdue container and upcoming deadlines within the six-day window.
      // Gate Out is the only completion condition used for excluding a container.
      if(days>DEADLINE_ALERT_WINDOW_DAYS)continue;
      const det=detentionInfo(cy);
      const confirmedLate=hasValue(cy.port_gate_in)&&det.days!==null&&det.days<0;
      const item={cntr,days,deadline:cy.deadline,status:cy.stuffing_status||currentStatus(d),carrier:cy.carrier||d.archive?.carrier||'',lsp:cy.lsp||'',customer:cy.customer||d.customer?.customer||'',cy,confirmedLate,detentionDays:det.days};
      const prev=best.get(cntr);
      if(!prev||(item.confirmedLate&&!prev.confirmedLate)||(item.confirmedLate===prev.confirmedLate&&item.days<prev.days))best.set(cntr,item);
    }
  }
  return [...best.values()].sort((a,b)=>(b.confirmedLate-a.confirmedLate)||(a.confirmedLate?a.detentionDays-b.detentionDays:0)||a.days-b.days||dateOnlyMs(a.deadline)-dateOnlyMs(b.deadline)||a.cntr.localeCompare(b.cntr));
}
function renderDeadlineAlerts(){
  if(!deadlineAlerts)return;
  const alerts=getDeadlineAlerts();
  deadlineAlertContainers=alerts.map(x=>x.cntr);
  const counts={overdue:0,due:0,urgent:0,warning:0,upcoming:0};
  alerts.forEach(a=>counts[deadlineAlertLevel(a.days).key]++);
  const todayLabel=new Date().toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'});
  if(!alerts.length){
    deadlineAlerts.className='deadline-alerts visible';
    deadlineAlerts.innerHTML=`<div class="deadline-alerts-header"><div class="deadline-alerts-icon">🔔</div><div class="deadline-alerts-title"><h2>Deadline Notifications</h2><p>Overdue containers and deadlines within the next ${DEADLINE_ALERT_WINDOW_DAYS} calendar days — excluding any container with Gate Out · As of ${esc(todayLabel)}</p></div><span class="deadline-alert-count">0</span></div><div class="deadline-alert-empty">✅ No overdue containers or upcoming deadlines within the next ${DEADLINE_ALERT_WINDOW_DAYS} days without Gate Out.</div>`;
    return;
  }
  const rows=alerts.map(a=>{const level=deadlineAlertLevel(a.days),deadlineLabel=fmtDatePlain(a.deadline)||'—';return`<tr${a.confirmedLate?' class="deadline-priority-row"':''}><td class="deadline-cntr">${a.confirmedLate?'<span class="deadline-priority-badge" title="Gated in to the port after the deadline — confirmed detention">🔴 PRIORITY</span> ':''}${esc(a.cntr)}</td><td><span class="deadline-date-value">${esc(deadlineLabel)}</span></td><td><span class="deadline-days-pill ${level.cls}" title="Deadline: ${esc(deadlineLabel)}">${esc(level.label)}</span></td><td>${statusPill(a.status)}</td><td>${valueHtml(a.carrier)}</td><td>${valueHtml(a.lsp)}</td><td>${valueHtml(a.customer)}</td><td><button type="button" class="deadline-open-btn" data-alert-cntr="${esc(a.cntr)}">Open</button></td></tr>`}).join('');
  deadlineAlerts.className='deadline-alerts visible';
  deadlineAlerts.innerHTML=`<div class="deadline-alerts-header"><div class="deadline-alerts-icon">🔔</div><div class="deadline-alerts-title"><h2>Deadline Notifications</h2><p>Overdue containers and deadlines within the next ${DEADLINE_ALERT_WINDOW_DAYS} calendar days — excluding any container with Gate Out · As of ${esc(todayLabel)}</p></div><span class="deadline-alert-count">${alerts.length}</span><div class="deadline-alert-actions"><button type="button" class="deadline-report-btn" id="deadlineReportBtn">Combined Report</button><button type="button" class="deadline-toggle-btn" id="deadlineToggleBtn">Collapse</button></div></div><div class="deadline-summary"><div class="deadline-summary-item"><i class="deadline-summary-dot" style="background:#7F1D1D"></i><div><strong>${counts.overdue}</strong><span>Overdue</span></div></div><div class="deadline-summary-item"><i class="deadline-summary-dot" style="background:#D63B3B"></i><div><strong>${counts.due}</strong><span>Due today</span></div></div><div class="deadline-summary-item"><i class="deadline-summary-dot" style="background:#D97706"></i><div><strong>${counts.urgent}</strong><span>Within 1–2 days</span></div></div><div class="deadline-summary-item"><i class="deadline-summary-dot" style="background:#D5A000"></i><div><strong>${counts.warning}</strong><span>Within 3–4 days</span></div></div><div class="deadline-summary-item"><i class="deadline-summary-dot" style="background:#2176AE"></i><div><strong>${counts.upcoming}</strong><span>Within 5–6 days</span></div></div></div><div class="deadline-alert-body"><table class="deadline-alert-table"><thead><tr><th>Container</th><th>Deadline Date</th><th>Alert</th><th>Status</th><th>Carrier</th><th>LSP</th><th>Customer</th><th>View</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  enhanceTable(document.querySelector('.deadline-alert-table'),{noSortCols:[7],noFilterCols:[7]});
}
function clearDeadlineAlerts(){deadlineAlertContainers=[];if(deadlineAlerts){deadlineAlerts.className='deadline-alerts';deadlineAlerts.innerHTML=''}}
function valueHtml(v){return hasValue(v)?esc(v):'<span class="null">—</span>'}
function statusPill(v){if(!hasValue(v))return'<span class="null">—</span>';const s=normStatus(v),map={'OUT':'sp-green','OUT EMPTY':'sp-green','LOCAL':'sp-purple','IN SIDE FACTORY':'sp-teal','EMPTY':'sp-gray','OUT OF SERVICE':'sp-red','OUT FOR LD':'sp-orange','OUT FOR FIX':'sp-orange','FINAL SEAL':'sp-blue','HALF SEAL':'sp-orange','W/H KD':'sp-gray','W/H FDC':'sp-gray','W/H':'sp-gray','DONE':'sp-green','IN YARD':'sp-orange'};return`<span class="status-pill ${map[s]||'sp-gray'}">${esc(s)}</span>`}
function sealBadge(v){if(!hasValue(v))return'—';const s=normStatus(v),key=s.includes('FINAL')?'FINAL':s.includes('HALF')?'HALF':s.includes('EMPTY')?'EMPTY':s.includes('LOCAL')?'LOCAL':'OTHER';return`<span class="seal-badge seal-${key}">${esc(s)}</span>`}
function dockBadge(v){if(!hasValue(v))return'—';const s=normStatus(v),key=['FDC','KD','MX'].includes(s)?s:'OTHER';return`<span class="dock-badge dock-${key}">${esc(s)}</span>`}
function currentStatus(d){return d._statusOverride||d.cy?.stuffing_status||d.customer?.status||d.archive?.status||(d._yardOnly?'IN YARD':'—')}
function countEmptyContainers(){if(!DATA||!KEYS.length)return 0;let n=0;for(const cntr of KEYS){if(normStatus(currentStatus(DATA[cntr]))==='EMPTY')n++}return n}
function uniqueSearchValues(values){const seen=new Set(),out=[];for(const value of values){if(!hasValue(value))continue;const display=normalizeText(value);if(!display)continue;const key=display.toUpperCase();if(seen.has(key))continue;seen.add(key);out.push(display)}return out}
function buildSearchFields(k){const d=DATA[k]||{},archives=d.archive_records||[],customers=d.customer_records||[],returns=d.will_back_records||[],cys=d.cy_records||[],moves=d.movements||[];const a=d.archive||{},c=d.customer||{},w=d.will_back||{},y=d.cy||{};return{
Container:[k],
Booking:uniqueSearchValues([y.withdrawal_bc,y.allocated_bc,...cys.flatMap(r=>[r.withdrawal_bc,r.allocated_bc])]),
Seal:uniqueSearchValues([a.seal_num,...archives.map(r=>r.seal_num)]),
Customer:uniqueSearchValues([c.customer,y.customer,...customers.map(r=>r.customer),...cys.map(r=>r.customer)]),
Carrier:uniqueSearchValues([a.carrier,c.carrier,y.carrier,...archives.map(r=>r.carrier),...customers.map(r=>r.carrier),...cys.map(r=>r.carrier),...moves.map(r=>r.carrier)]),
LSP:uniqueSearchValues([y.lsp,...cys.map(r=>r.lsp)]),
PIC:uniqueSearchValues([a.pic,c.pic,...archives.map(r=>r.pic),...customers.map(r=>r.pic)]),
Status:uniqueSearchValues([a.status,c.status,y.stuffing_status,...archives.map(r=>r.status),...customers.map(r=>r.status),...cys.map(r=>r.stuffing_status)]),
Terminal:uniqueSearchValues([y.terminal,...cys.map(r=>r.terminal)]),
Remarks:uniqueSearchValues([a.remarks,w.remarks,y.remarks,...archives.map(r=>r.remarks),...returns.map(r=>r.remarks),...cys.map(r=>r.remarks),...moves.map(r=>r.remarks)])}}
function buildSearchIndexRecord(key){const fields=buildSearchFields(key);return{key,fields,text:Object.values(fields).flat().join(' ').toUpperCase()}}
function normalizedQuery(q){return normalizeText(q).toUpperCase()}
function getMatchDetails(record,query){const n=normalizedQuery(query);if(n.length<2)return[];const details=[];for(const [field,values] of Object.entries(record.fields||{})){for(const value of values||[]){const display=normalizeText(value);if(display.toUpperCase().includes(n))details.push({field,value:display})}}return details}
function searchText(k){const fields=buildSearchFields(k);return Object.values(fields).flat().filter(hasValue).join(' ').toUpperCase()}
let SEARCH_INDEX=[];
function getMatches(q,limit=12){const n=normalizedQuery(q);if(n.length<2)return[];return SEARCH_INDEX.filter(x=>x.text.includes(n)).slice(0,limit)}
function renderSuggestions(q){const matches=getMatches(q,12);if(!matches.length){suggestBox.style.display='none';return}suggestBox.innerHTML=matches.map(({key})=>{const d=DATA[key],s=currentStatus(d),detail=d.cy?.customer||d.customer?.customer||d.cy?.carrier||d.archive?.carrier||'';return`<div class="sugg-item" data-cntr="${esc(key)}"><span>${esc(key)}</span><span class="sugg-badge ${normStatus(s)==='OUT'?'sp-green':'sp-gray'}">${esc(s)}</span><span style="color:#B0BEC5;font-size:11px;margin-left:auto">${esc(detail)} · ${(d.movements||[]).length} moves</span></div>`}).join('');suggestBox.style.display='block'}
input.addEventListener('input',(()=>{const debouncedRender=debounce(q=>renderSuggestions(q),100);return()=>{const q=input.value;clearBtn.style.display=q.trim()?'block':'none';debouncedRender(q)}})());input.addEventListener('keydown',e=>{if(e.key==='Enter')resolveSearch(input.value);if(e.key==='Escape')suggestBox.style.display='none'});searchBtn.addEventListener('click',()=>resolveSearch(input.value));suggestBox.addEventListener('click',e=>{const item=e.target.closest('[data-cntr]');if(item)doSearch(item.dataset.cntr)});clearBtn.addEventListener('click',clearSearch);document.addEventListener('click',e=>{if(!e.target.closest('.search-input-wrap'))suggestBox.style.display='none'});batchToggleBtn.addEventListener('click',()=>{const open=!batchPanel.classList.contains('open');batchPanel.classList.toggle('open',open);batchToggleBtn.classList.toggle('active',open);batchToggleBtn.textContent=open?'− Close Multi-Search & Report':'＋ Multi-Search & Combined Report';if(open)batchInput.focus()});batchInput.addEventListener('input',updateBatchCounter);batchInput.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key==='Enter')runBatchSearch()});batchRunBtn.addEventListener('click',runBatchSearch);batchClearBtn.addEventListener('click',()=>{batchInput.value='';updateBatchCounter();batchInput.focus()});resultDiv.addEventListener('click',e=>{const b=e.target.closest('[data-open-cntr]');if(b)doSearch(b.dataset.openCntr)});
deadlineAlerts?.addEventListener('click',e=>{
  const open=e.target.closest('[data-alert-cntr]');
  if(open)return doSearch(open.dataset.alertCntr);
  if(e.target.closest('#deadlineReportBtn')){
    if(!deadlineAlertContainers.length)return;
    batchInput.value=deadlineAlertContainers.join('\n');
    updateBatchCounter();
    batchPanel.classList.add('open');
    batchToggleBtn.classList.add('active');
    batchToggleBtn.textContent='− Close Multi-Search & Report';
    currentBatchContext=directBatchContext(deadlineAlertContainers,'Deadline notifications');
    renderBatchResults(deadlineAlertContainers,[],currentBatchContext);
    return;
  }
  const toggle=e.target.closest('#deadlineToggleBtn');
  if(toggle){const collapsed=deadlineAlerts.classList.toggle('collapsed');toggle.textContent=collapsed?'Expand':'Collapse'}
});
function clearSearch(){input.value='';currentContainer=null;currentBatchContainers=[];currentBatchContext=null;clearBtn.style.display='none';suggestBox.style.display='none';resultDiv.style.display='none';resultDiv.innerHTML='';emptyState.style.display='block';notFound.style.display='none';safeHistoryReplace(location.pathname);input.focus()}
function resolveSearch(q){if(/[,;\n\t|]/.test(String(q))&&parseBatchQueries(q).length>1){batchInput.value=q;updateBatchCounter();batchPanel.classList.add('open');batchToggleBtn.classList.add('active');batchToggleBtn.textContent='− Close Multi-Search & Report';return runBatchSearch()}const exact=normalizeContainer(q);if(DATA[exact])return doSearch(exact);const matches=getMatches(q,300);if(matches.length===1)return doSearch(matches[0].key);if(matches.length>1&&matches.length<=8){renderSuggestions(q);showToast(`${matches.length} matches found — select a container`);return}if(matches.length>8){batchInput.value=matches.map(m=>m.key).join('\n');updateBatchCounter();batchPanel.classList.add('open');batchToggleBtn.classList.add('active');batchToggleBtn.textContent='− Close Multi-Search & Report';showToast(`${matches.length} matches found — showing combined report below`);return runBatchSearch()}showNotFound(q)}
function parseBatchQueries(text){const segments=String(text||'').replace(/\r/g,'\n').split(/[\n,;|\t]+/).map(v=>normalizeText(v).replace(/^["']|["']$/g,'')).filter(v=>v.length>=2),expanded=[];for(const segment of segments){const words=segment.split(/\s+/).filter(Boolean),allContainers=words.length>1&&words.every(v=>/^[A-Z*]{3,5}\d{5,10}$/i.test(v));if(allContainers)expanded.push(...words);else expanded.push(segment)}const seen=new Set(),out=[];for(const value of expanded){const key=value.toUpperCase();if(seen.has(key))continue;seen.add(key);out.push(value)}return out}
function parseBatchTerms(text){return parseBatchQueries(text)}
function updateBatchCounter(){const n=parseBatchQueries(batchInput.value).length;batchCounter.textContent=`${n} unique search ${n===1?'value':'values'}`}
function directBatchContext(cntrs,label='Container list'){const containerMatches={};for(const cntr of cntrs)containerMatches[cntr]=[{query:cntr,field:'Container',value:cntr}];return{queries:cntrs.map(q=>({query:q,count:1,containers:[q]})),missing:[],containerMatches,label}}
function runBatchSearch(){const queries=parseBatchQueries(batchInput.value);if(!queries.length){showToast('Enter at least one search value');batchInput.focus();return}const foundSet=new Set(),missing=[],queryResults=[],containerMatches={};for(const query of queries){const exact=normalizeContainer(query),matches=[];if(DATA[exact]){const rec=SEARCH_INDEX.find(x=>x.key===exact)||buildSearchIndexRecord(exact);matches.push({record:rec,details:[{field:'Container',value:exact}]})}else{for(const record of SEARCH_INDEX){const details=getMatchDetails(record,query);if(details.length)matches.push({record,details})}}if(!matches.length){missing.push(query);queryResults.push({query,count:0,containers:[]});continue}const queryContainers=[];for(const match of matches){const cntr=match.record.key;foundSet.add(cntr);queryContainers.push(cntr);if(!containerMatches[cntr])containerMatches[cntr]=[];for(const detail of match.details){const signature=`${query.toUpperCase()}|${detail.field}|${detail.value.toUpperCase()}`;if(!containerMatches[cntr].some(x=>x.signature===signature))containerMatches[cntr].push({query,field:detail.field,value:detail.value,signature})}}queryResults.push({query,count:new Set(queryContainers).size,containers:[...new Set(queryContainers)]})}const found=[...foundSet].sort();currentBatchContainers=found;currentBatchContext={queries:queryResults,missing,containerMatches,label:'Multi-option search'};if(!found.length){emptyState.style.display='none';resultDiv.style.display='none';notFound.style.display='block';document.getElementById('notFoundCode').textContent=missing.join(', ');showToast('No containers matched the entered search values');return}renderBatchResults(found,missing,currentBatchContext)}
function batchSummary(cntr,context=currentBatchContext){const d=DATA[cntr],cy=d.cy||{},a=d.archive||{},c=d.customer||{},moves=d.movements||[],det=detentionInfo(cy),matchDetails=context?.containerMatches?.[cntr]||[];return{cntr,status:currentStatus(d),size:cy.type||a.size||c.size||moves[0]?.size||'',carrier:cy.carrier||a.carrier||c.carrier||moves[0]?.carrier||'',customer:cy.customer||c.customer||'',lsp:cy.lsp||'',deadline:fmtDatePlain(cy.deadline),gateIn:fmtDatePlain(a.gate_in||cy.arrival_date),gateOut:fmtDatePlain(a.gate_out||cy.gate_out),detentionDays:det.days,detentionStatus:det.status,moves:moves.length,archive:(d.archive_records||[]).length,cy:(d.cy_records||[]).length,matchDetails}}
function matchTagsHtml(details){if(!details||!details.length)return'<span class="null">Direct selection</span>';const unique=[],seen=new Set();for(const item of details){const key=`${item.field}|${item.value}`.toUpperCase();if(seen.has(key))continue;seen.add(key);unique.push(item)}return`<div class="match-tags">${unique.slice(0,8).map(x=>`<span class="match-tag"><b>${esc(x.field)}:</b> ${esc(x.value)}</span>`).join('')}${unique.length>8?`<span class="match-tag">+${unique.length-8} more</span>`:''}</div>`}
function renderBatchResults(cntrs,missing=[],context=null){suggestBox.style.display='none';currentContainer=null;emptyState.style.display='none';notFound.style.display='none';currentBatchContext=context||currentBatchContext||directBatchContext(cntrs);currentBatchContainers=cntrs;const summaries=cntrs.map(c=>batchSummary(c,currentBatchContext)),totalMoves=summaries.reduce((n,r)=>n+r.moves,0),totalDetention=summaries.reduce((n,r)=>n+(Number(r.detentionDays)||0),0),queryResults=currentBatchContext?.queries||[];let out=`<div class="batch-hero"><div><h2>Multi-Option Combined Report</h2><p>${queryResults.length||cntrs.length} search value${(queryResults.length||cntrs.length)===1?'':'s'} matched ${cntrs.length} unique container${cntrs.length===1?'':'s'} · duplicate results were merged</p></div><div class="batch-kpis"><div class="batch-kpi"><strong>${queryResults.length||cntrs.length}</strong><span>Search Values</span></div><div class="batch-kpi"><strong>${cntrs.length}</strong><span>Containers</span></div><div class="batch-kpi"><strong>${totalMoves}</strong><span>Movements</span></div><div class="batch-kpi"><strong>${totalDetention}</strong><span>Detention Days</span></div></div></div>`;if(missing.length)out+=`<div class="batch-missing"><strong>No matches (${missing.length}):</strong> ${missing.map(x=>`<code>${esc(x)}</code>`).join(' ')}</div>`;out+=`<div class="batch-export-bar"><span class="download-bar-label">📥 Combined Export</span><button class="dl-btn dl-btn-excel" id="batchExcelBtn"><span class="dl-btn-icon">📊</span> Download One Excel File</button><button class="dl-btn dl-btn-pdf" id="batchPdfBtn"><span class="dl-btn-icon">📄</span> Print / Save One PDF</button><span style="margin-left:auto;color:var(--muted);font-size:11px">All matched containers are exported once</span></div>`;out+=`<div class="card section-full"><div class="card-header"><div class="card-header-icon" style="background:#EAF2FF">📦</div><h3>Matched Containers Summary</h3><span class="card-count">${cntrs.length}</span></div><div class="movements-wrap"><table class="batch-summary-table"><thead><tr><th>Container</th><th>Matched By</th><th>Status</th><th>Size</th><th>Carrier</th><th>Customer</th><th>LSP</th><th>Deadline</th><th>Detention Days</th><th>Detention Status</th><th>Gate In</th><th>Gate Out</th><th>Moves</th><th>Archive</th><th>CY</th><th>View</th></tr></thead><tbody>${summaries.map(r=>`<tr><td class="mono"><strong>${esc(r.cntr)}</strong></td><td>${matchTagsHtml(r.matchDetails)}</td><td>${statusPill(r.status)}</td><td>${valueHtml(r.size)}</td><td>${valueHtml(r.carrier)}</td><td>${valueHtml(r.customer)}</td><td>${valueHtml(r.lsp)}</td><td>${r.deadline||'—'}</td><td class="mono"><strong>${hasValue(r.detentionDays)?r.detentionDays:'—'}</strong></td><td>${(Number(r.detentionDays)<0)?`<span class="status-pill sp-red">${esc(r.detentionStatus)}</span>`:`<span class="status-pill sp-green">${esc(r.detentionStatus)}</span>`}</td><td>${r.gateIn||'—'}</td><td>${r.gateOut||'—'}</td><td class="mono">${r.moves}</td><td class="mono">${r.archive}</td><td class="mono">${r.cy}</td><td><button class="batch-open-btn" data-open-cntr="${esc(r.cntr)}">Open</button></td></tr>`).join('')}</tbody></table></div></div>`;resultDiv.innerHTML=out;resultDiv.style.display='block';document.getElementById('batchExcelBtn').addEventListener('click',()=>downloadBatchExcel(cntrs,missing,currentBatchContext));document.getElementById('batchPdfBtn').addEventListener('click',()=>downloadBatchPDF(cntrs,currentBatchContext));enhanceTable(document.querySelector('.batch-summary-table'),{noSortCols:[15],noFilterCols:[15]});safeHistoryReplace(location.pathname);resultDiv.scrollIntoView({behavior:'smooth',block:'start'})}
function batchMatchPlain(cntr,context=currentBatchContext){const details=context?.containerMatches?.[cntr]||[],seen=new Set(),parts=[];for(const x of details){const text=`${x.field}: ${x.value}`;if(seen.has(text.toUpperCase()))continue;seen.add(text.toUpperCase());parts.push(text)}return parts.join(' | ')}
function getBatchExportData(cntrs,context=currentBatchContext){const all={summaries:[],moves:[],archives:[],customers:[],returns:[],cys:[],criteria:[]};for(const q of context?.queries||[]){if(!q.containers.length)all.criteria.push([q.query,0,'','']);else for(const cntr of q.containers){const reasons=(context?.containerMatches?.[cntr]||[]).filter(x=>String(x.query).toUpperCase()===String(q.query).toUpperCase()).map(x=>`${x.field}: ${x.value}`).join(' | ');all.criteria.push([q.query,q.count,cntr,reasons])}}cntrs.forEach(cntr=>{const d=getExportData(cntr),r=batchSummary(cntr,context);all.summaries.push([cntr,batchMatchPlain(cntr,context),r.status,r.size,r.carrier,r.customer,r.lsp,r.deadline,hasValue(r.detentionDays)?r.detentionDays:'',r.detentionStatus,r.gateIn,r.gateOut,r.moves,r.archive,r.cy]);all.moves.push(...d.moves.map(row=>[cntr,...row]));all.archives.push(...d.archives);all.customers.push(...d.customers);all.returns.push(...d.returns);all.cys.push(...d.cys)});return all}
function requireExportPermission(){
  if(!currentUserCan('canExport')){
    alert("You don't have permission to export reports. Ask the Controller to grant the Export permission from Manage Users.");
    return false;
  }
  return true;
}
function downloadBatchExcel(cntrs,missing=[],context=currentBatchContext){if(!requireExportPermission())return;try{const x=getBatchExportData(cntrs,context),generated=new Date().toLocaleString('en-GB'),summaryMeta=[['Report Type','Multi-Option Combined Report'],['Export Date',generated],['Search Values',context?.queries?.length||cntrs.length],['Containers Found',cntrs.length],['Search Values Without Matches',missing.length],['Movement Records',x.moves.length],['Archive Records',x.archives.length],['CY Records',x.cys.length],['Unmatched Search Values',missing.join(', ')]];const xml=`<?xml version="1.0"?><?mso-application progid="Excel.Sheet"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Styles><Style ss:ID="Header"><Font ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#1B4F8A" ss:Pattern="Solid"/></Style></Styles>${ssSheet('Report Info',['Field','Value'],summaryMeta)}${ssSheet('Search Criteria',['Search Value','Total Matches','Container','Matched Field'],x.criteria)}${ssSheet('Containers Summary',['Container','Matched By','Status','Size','Carrier','Customer','LSP','Deadline','Detention Days','Detention Status','Gate In','Gate Out','Movement Records','Archive Records','CY Records'],x.summaries)}${ssSheet('CY Management',['Container','Ser','Type','Tare Weight','Term','Arrived As','Withdrawal BC','Assignment Date','Arrival Date','Terminal','LSP','Carrier','Deadline','Remaining','Stuffing Status','Production Week','Customer','Allocated BC','Gate Out','Gate In to Port','Detention Days','Detention Status','Detention Calculation','Remarks'],x.cys)}${ssSheet('Archive & Stock',['Container','Size','Gate In','Gate Out','Carrier','Arrived As','Status','PIC','Seal No.','Seal Photos','Remarks','Source Sheet'],x.archives)}${ssSheet('With Customer',['Container','Size','Carrier','Arrived As','Remaining','Customer','Status','Date','PIC'],x.customers)}${ssSheet('Will Back Again',['Container','Size','Gate In','Gate Out','Remarks'],x.returns)}${ssSheet('Movement History',['Container','#','Date','Dock','Start Time','End Time','Duration','Seal Type','Carrier','Remarks'],x.moves)}</Workbook>`;const blob=new Blob([xml],{type:'application/vnd.ms-excel'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`CNTR_MULTI_SEARCH_${cntrs.length}_${new Date().toISOString().slice(0,10)}.xls`;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);showToast(`✅ Combined Excel downloaded — ${cntrs.length} containers`)}catch(e){alert('Combined export failed: '+e.message)}}
function pdfInfoTable(rows){return`<table class="pdf-info">${rows.map(r=>`<tr><td class="lbl">${xmlEscape(r[0])}</td><td>${xmlEscape(hasValue(r[1])?r[1]:'—')}</td><td class="lbl">${xmlEscape(r[2])}</td><td>${xmlEscape(hasValue(r[3])?r[3]:'—')}</td></tr>`).join('')}</table>`}
function batchPdfSection(cntr,index,total,context=currentBatchContext){const d=DATA[cntr],a=d.archive||{},c=d.customer||{},y=d.cy||{},moves=(d.movements||[]).slice().sort((p,q)=>new Date(p.start||p.date||0)-new Date(q.start||q.date||0)),r=batchSummary(cntr,context),det=detentionInfo(y),matched=batchMatchPlain(cntr,context)||'Direct selection';const moveRows=moves.map((m,i)=>`<tr><td>${i+1}</td><td>${xmlEscape(fmtDatePlain(m.date))}</td><td>${xmlEscape(m.dock||'')}</td><td>${xmlEscape(fmtTime(m.start))}</td><td>${xmlEscape(fmtTime(m.end))}</td><td>${xmlEscape(fmtDuration(m.duration_minutes))}</td><td>${xmlEscape(m.seal_type||'')}</td><td>${xmlEscape(m.carrier||'')}</td></tr>`).join('');return`<section class="container-page"><div class="page-count">Container ${index+1} of ${total}</div><div class="id">${xmlEscape(cntr)} <span>${xmlEscape(r.status)}</span></div><div style="padding:5px 7px;background:#F0F4F8;border:1px solid #D8E1EC;margin-bottom:7px"><strong>Matched By:</strong> ${xmlEscape(matched)}</div>${hasRecord(d.cy)?`<h3>CY MANAGEMENT</h3>${pdfInfoTable([['Status',y.stuffing_status,'Customer',y.customer],['Carrier',y.carrier,'LSP',y.lsp],['Arrival',fmtDatePlain(y.arrival_date),'Deadline',fmtDatePlain(y.deadline)],['Gate In to Port',fmtDatePlain(y.port_gate_in),'Detention Days',hasValue(det.days)?det.days:'—'],['Detention Status',det.status,'Calculation',det.detail],['Remaining',y.remaining,'Withdrawal BC',y.withdrawal_bc],['Allocated BC',y.allocated_bc,'Terminal',y.terminal]])}`:''}${hasRecord(d.archive)?`<h3>ARCHIVE & STOCK</h3>${pdfInfoTable([['Size',a.size,'Gate In',fmtDatePlain(a.gate_in)],['Gate Out',fmtDatePlain(a.gate_out),'Carrier',a.carrier],['Status',a.status,'Arrived As',a.arrived_as],['PIC',a.pic,'Seal No.',a.seal_num]])}`:''}${hasRecord(d.customer)?`<h3>WITH CUSTOMER</h3>${pdfInfoTable([['Customer',c.customer,'Status',c.status],['Size',c.size,'Carrier',c.carrier],['Arrived As',c.arrived_as,'Remaining',c.remaining],['Date',fmtDatePlain(c.date),'PIC',c.pic]])}`:''}<h3>MOVEMENT HISTORY (${moves.length})</h3><table class="moves"><thead><tr><th>#</th><th>Date</th><th>Dock</th><th>Start</th><th>End</th><th>Duration</th><th>Seal</th><th>Carrier</th></tr></thead><tbody>${moveRows||'<tr><td colspan="8">No movement records</td></tr>'}</tbody></table></section>`}
function downloadBatchPDF(cntrs,context=currentBatchContext){if(!requireExportPermission())return;const sections=cntrs.map((c,i)=>batchPdfSection(c,i,cntrs.length,context)).join(''),queryCount=context?.queries?.length||cntrs.length;const doc=`<!doctype html><html><head><meta charset="utf-8"><title>CNTR_MULTI_SEARCH_${cntrs.length}</title><style>@page{size:A4;margin:11mm}*{box-sizing:border-box}body{font-family:Arial;color:#1A2332;font-size:9px;margin:0}header{background:#0D1B2A;color:#fff;padding:14px;border-bottom:3px solid #F4A41B;margin-bottom:8px}header h1{margin:0;font-size:18px}header div{margin-top:4px;color:#A8C4E0}.container-page{break-after:page;page-break-after:always;position:relative}.container-page:last-child{break-after:auto;page-break-after:auto}.page-count{text-align:right;color:#6B7A90;font-size:8px}.id{background:#1B4F8A;color:#fff;padding:9px 11px;margin:5px 0 8px;font-size:16px;font-weight:bold}.id span{float:right;font-size:9px;background:rgba(255,255,255,.15);padding:4px 7px;border-radius:10px}h3{background:#0D1B2A;color:#fff;padding:5px 7px;margin:8px 0 0;font-size:10px}.pdf-info,.moves{width:100%;border-collapse:collapse}.pdf-info td,.moves td,.moves th{border:1px solid #D8E1EC;padding:4px}.lbl{font-weight:bold;background:#F0F4F8}.moves th{background:#1B4F8A;color:#fff}@media print{header{position:relative}}</style></head><body><header><h1>MULTI-OPTION COMBINED REPORT</h1><div>${cntrs.length} containers · ${queryCount} search values · Generated ${new Date().toLocaleString('en-GB')}</div></header>${sections}<script>window.onload=()=>window.print();<\/script></body></html>`;const win=window.open('','_blank');if(!win)return alert('Please allow pop-ups to print the combined report.');win.document.write(doc);win.document.close()}
function getDistinctFieldSample(fieldName,limit=6){
  const set=new Set();
  for(const rec of SEARCH_INDEX){
    (rec.fields[fieldName]||[]).forEach(v=>set.add(v));
    if(set.size>=limit*4)break;
  }
  return[...set].slice(0,limit);
}
function showNotFound(q){
  emptyState.style.display='none';resultDiv.style.display='none';notFound.style.display='block';
  document.getElementById('notFoundCode').textContent=normalizeText(q)||'—';
  const diag=document.getElementById('notFoundDiagnostics');
  if(!diag)return;
  if(!SEARCH_INDEX.length){diag.innerHTML='';return}
  const carriers=getDistinctFieldSample('Carrier'),customers=getDistinctFieldSample('Customer'),lsps=getDistinctFieldSample('LSP');
  const rows=[];
  if(carriers.length)rows.push(`<div class="nf-diag-row"><span class="nf-diag-label">Carriers</span><span class="nf-diag-val">${carriers.map(esc).join(', ')}</span></div>`);
  if(customers.length)rows.push(`<div class="nf-diag-row"><span class="nf-diag-label">Customers</span><span class="nf-diag-val">${customers.map(esc).join(', ')}</span></div>`);
  if(lsps.length)rows.push(`<div class="nf-diag-row"><span class="nf-diag-label">LSPs</span><span class="nf-diag-val">${lsps.map(esc).join(', ')}</span></div>`);
  diag.innerHTML=rows.length?`<div class="nf-diag-title">A few values currently in the system — compare spelling:</div>${rows.join('')}`:'';
}
function info(label,value,cls=''){return`<div class="info-item ${cls}"><span class="info-label">${label}</span><span class="info-value">${value}</span></div>`}
function cyCard(cy,count){if(!cy)return'<div class="card cy-card section-full"><div class="no-data"><span class="no-data-icon">🧭</span>No CY Management record found</div></div>';let body='';body+=info('Stuffing Status',statusPill(cy.stuffing_status));body+=info('Customer',valueHtml(cy.customer));body+=info('Remaining',valueHtml(cy.remaining));body+=info('Deadline to POL',fmtDate(cy.deadline));body+=info('Arrival Date',fmtDate(cy.arrival_date));body+=info('Assignment Date',fmtDate(cy.assignment_date));body+=info('Arrived As',valueHtml(cy.arrived_as));body+=info('Carrier',valueHtml(cy.carrier));body+=info('LSP',valueHtml(cy.lsp));body+=info('Withdrawal Terminal',valueHtml(cy.terminal));body+=info('Withdrawal BC',valueHtml(cy.withdrawal_bc));body+=info('Allocated BC',valueHtml(cy.allocated_bc));body+=info('Term',valueHtml(cy.term));body+=info('Type',valueHtml(cy.type));body+=info('Tare Weight',valueHtml(cy.tare_weight));body+=info('Production Week',valueHtml(cy.pro_week));body+=info('Gate Out',fmtDate(cy.gate_out));body+=info('Gate In to Port',fmtDate(cy.port_gate_in));body+=info('Detention Days',detentionHtml(cy),'full');if(cy.remarks)body+=info('Remarks',esc(cy.remarks),'full');return`<div class="card cy-card section-full"><div class="card-header"><div class="card-header-icon" style="background:#E2F4F5">🧭</div><h3>CY Management</h3><span class="card-count">${count} record${count===1?'':'s'}</span></div><div class="card-body"><div class="info-grid cy-grid">${body}</div></div></div>`}
function doSearch(cntr){cntr=normalizeContainer(cntr);const d=DATA[cntr];suggestBox.style.display='none';if(!d)return showNotFound(cntr);currentContainer=cntr;input.value=cntr;clearBtn.style.display='block';emptyState.style.display='none';notFound.style.display='none';const arch=d.archive,cust=d.customer,wb=d.will_back,cy=d.cy,moves=(d.movements||[]).slice().sort((a,b)=>new Date(a.start||a.date||0)-new Date(b.start||b.date||0));const status=currentStatus(d),size=cy?.type||arch?.size||cust?.size||moves[0]?.size||'—',carrier=cy?.carrier||arch?.carrier||cust?.carrier||moves[0]?.carrier||'—';let out=`<div class="identity-card"><div class="identity-main"><div class="identity-num">${esc(cntr)}</div><div class="identity-badges">${statusPill(status)}${hasValue(size)&&size!=='—'?`<span class="badge badge-size">📏 ${esc(size)}</span>`:''}${hasValue(carrier)&&carrier!=='—'?`<span class="badge badge-carrier">🚢 ${esc(carrier)}</span>`:''}${cy?'<span class="badge badge-cy">🧭 CY Linked</span>':''}${wb?'<span class="badge" style="background:rgba(244,164,27,.2);color:#FAC85B">🔄 Will Return</span>':''}${(cy?.customer||cust)?'<span class="badge" style="background:rgba(255,255,255,.08);color:#A8C4E0">👤 Customer Data</span>':''}</div><div class="source-note">Linked from 2 separate Excel workbooks</div></div><div class="identity-stats"><div class="istat"><div class="istat-val">${moves.length}</div><div class="istat-lbl">Moves</div></div>${arch?'<div class="istat"><div class="istat-val">✓</div><div class="istat-lbl">Archive</div></div>':''}${cy?'<div class="istat"><div class="istat-val">✓</div><div class="istat-lbl">CY</div></div>':''}</div></div>`;const quality=[...(d.quality||[])];if(d.long_movements)quality.push(`${d.long_movements} movement(s) exceed 24 hours`);if(iso6346CheckDigitValid(cntr)===false)quality.push('Container number fails the standard ISO 6346 check digit — double-check it was typed correctly');if(quality.length)out+=`<div class="quality-banner"><strong>Data Notes:</strong> ${quality.map(esc).join(' • ')}</div>`;if(d._yardOnly)out+=`<div class="quality-banner">📍 <strong>Yard-only record:</strong> this container isn't in either Excel workbook yet — only its yard location is on record.</div>`;out+=`<div class="data-source-strip"><span class="source-chip">📘 Movement Report: ${(d.movements||[]).length} movement(s), ${(d.archive_records||[]).length} archive record(s)</span><span class="source-chip">📗 CY Report: ${(d.cy_records||[]).length} record(s)</span></div>`;out+=`<div class="download-bar"><span class="download-bar-label">📥 Export</span><button class="dl-btn dl-btn-excel" id="exportExcelBtn"><span class="dl-btn-icon">📊</span> Download Excel (.xls)</button><button class="dl-btn dl-btn-pdf" id="exportPdfBtn"><span class="dl-btn-icon">📄</span> Print / Save PDF</button><button class="dl-btn" id="yardLogBtn" style="background:linear-gradient(135deg,#8A5A0A,#D97706);color:#fff"><span class="dl-btn-icon">📍</span> ${(()=>{const yl=loadYardLocations()[cntr];return yl?`Yard: ${esc(yardLocationLabel(yl))}`:'Log Yard Location'})()}</button>${loadYardLocations()[cntr]?'<button class="dl-btn" id="yardMapBtn" style="background:linear-gradient(135deg,#14707A,#0E7C86);color:#fff"><span class="dl-btn-icon">🗺️</span> View on Yard Map</button>':''}</div>`;if(wb)out+=`<div class="will-back-card"><div class="will-back-icon">🔄</div><div><div class="will-back-title">Expected to Return</div><div class="will-back-info">Size: <strong>${valueHtml(wb.size)}</strong> &nbsp;|&nbsp; Gate In: <strong>${fmtDate(wb.gate_in)}</strong> &nbsp;|&nbsp; Gate Out: <strong>${fmtDate(wb.gate_out)}</strong>${wb.remarks?` &nbsp;|&nbsp; Note: <strong>${esc(wb.remarks)}</strong>`:''}</div></div></div>`;out+=cyCard(cy,(d.cy_records||[]).length);out+='<div class="sections-grid">';out+=arch?`<div class="card"><div class="card-header"><div class="card-header-icon" style="background:#EAF2FF">🏪</div><h3>Archive & Stock</h3><span class="card-count">${(d.archive_records||[]).length}</span></div><div class="card-body"><div class="info-grid">${info('Status',statusPill(arch.status))}${info('Size',valueHtml(arch.size))}${info('Gate In',fmtDate(arch.gate_in))}${info('Gate Out',fmtDate(arch.gate_out))}${info('Carrier',valueHtml(arch.carrier))}${info('Arrived As',valueHtml(arch.arrived_as))}${info('PIC',valueHtml(arch.pic))}${info('Seal No.',valueHtml(arch.seal_num))}${info('Seal Photos',valueHtml(arch.seal_photos))}${arch.remarks?info('Remarks',esc(arch.remarks),'full'):''}</div></div></div>`:'<div class="card"><div class="no-data"><span class="no-data-icon">🏪</span>No archive record found</div></div>';out+=cust?`<div class="card"><div class="card-header"><div class="card-header-icon" style="background:#E6F7EF">👤</div><h3>With Customer</h3><span class="card-count">${(d.customer_records||[]).length}</span></div><div class="card-body"><div class="info-grid">${info('Status',statusPill(cust.status))}${info('Customer',valueHtml(cust.customer))}${info('Carrier',valueHtml(cust.carrier))}${info('Size',valueHtml(cust.size))}${info('Arrived As',valueHtml(cust.arrived_as))}${info('Remaining',valueHtml(cust.remaining))}${info('Date',fmtDate(cust.date))}${info('PIC',valueHtml(cust.pic))}</div></div></div>`:'<div class="card"><div class="no-data"><span class="no-data-icon">👤</span>No customer record found</div></div>';out+='</div>';const INIT=15;out+=`<div class="card section-full"><div class="card-header"><div class="card-header-icon" style="background:#EAF2FF">📋</div><h3>Movement History</h3><span class="card-count">${moves.length} records</span></div>`;if(!moves.length)out+='<div class="no-data"><span class="no-data-icon">📋</span>No movement records found</div>';else{out+='<div class="movements-wrap"><table class="movements-table"><thead><tr><th>#</th><th>Date</th><th>Dock</th><th>Start Time</th><th>End Time</th><th>Duration</th><th>Seal Type</th><th>Carrier</th><th>Remarks</th></tr></thead><tbody id="movTbody">';moves.forEach((m,i)=>{out+=`<tr${i>=INIT?' class="extra-row" style="display:none"':''}><td class="mono" style="color:#B0BEC5">${i+1}</td><td class="mono">${fmtDate(m.date)}</td><td>${dockBadge(m.dock)}</td><td class="mono">${fmtTime(m.start)}</td><td class="mono">${fmtTime(m.end)}</td><td class="mono" style="color:var(--muted)">${fmtDuration(m.duration_minutes)}</td><td>${sealBadge(m.seal_type)}</td><td style="color:var(--muted);font-size:12px">${valueHtml(m.carrier)}</td><td style="color:var(--muted);font-size:12px">${valueHtml(m.remarks)}</td></tr>`});out+='</tbody></table>';if(moves.length>INIT)out+=`<button class="show-more-btn" id="showMoreBtn">Show all ${moves.length} records ↓</button>`;out+='</div>'}out+='</div>';resultDiv.innerHTML=out;resultDiv.style.display='block';document.getElementById('exportExcelBtn')?.addEventListener('click',()=>downloadExcel(cntr));document.getElementById('exportPdfBtn')?.addEventListener('click',()=>downloadPDF(cntr));document.getElementById('yardLogBtn')?.addEventListener('click',()=>openYardModal(cntr));document.getElementById('yardMapBtn')?.addEventListener('click',()=>openYardMapForContainer(cntr));document.getElementById('showMoreBtn')?.addEventListener('click',toggleRows);movRowsExpanded=false;enhanceTable(document.querySelector('.movements-table'),{collapsedCheck:()=>movRowsExpanded});safeHistoryReplace(`${location.pathname}?cntr=${encodeURIComponent(cntr)}`);resultDiv.scrollIntoView({behavior:'smooth',block:'start'})}
let movRowsExpanded=false;
function positionDropdown(dd,btn){
  if(!btn)return;
  const r=btn.getBoundingClientRect();
  dd.style.position='fixed';
  dd.style.visibility='hidden';
  dd.style.top='0px';dd.style.left='0px';dd.style.maxHeight='none';
  const ddW=dd.offsetWidth||220;
  let left=r.right-ddW;
  if(left<8)left=Math.min(r.left,window.innerWidth-ddW-8);
  left=Math.max(8,left);
  const spaceBelow=window.innerHeight-r.bottom-12,spaceAbove=r.top-12;
  const naturalH=dd.scrollHeight;
  let top,maxH;
  if(naturalH<=spaceBelow||spaceBelow>=spaceAbove){
    // fits below, or below still has more room than above — anchor below and cap to whatever fits
    top=r.bottom+4;
    maxH=Math.max(160,Math.min(naturalH,spaceBelow));
  }else{
    // more room above — anchor above, growing upward, capped to fit
    maxH=Math.max(160,Math.min(naturalH,spaceAbove));
    top=Math.max(8,r.top-maxH-4);
  }
  dd.style.maxHeight=maxH+'px';
  dd.style.overflowY='auto';
  dd.style.left=left+'px';
  dd.style.top=top+'px';
  dd.style.visibility='visible';
}
function enhanceTable(table,opts={}){
  if(!table)return;
  table.classList.add('tf-table');
  const thead=table.querySelector('thead'),tbody=table.querySelector('tbody');
  if(!thead||!tbody)return;
  const headerRow=thead.querySelector('tr');
  if(!headerRow)return;
  const cols=Array.from(headerRow.children);
  const noSortCols=new Set(opts.noSortCols||[]),noFilterCols=new Set(opts.noFilterCols||[]);
  const activeFilters={};
  let clearBar=table.previousElementSibling?.classList?.contains('tf-clearbar')?table.previousElementSibling:null;
  if(!clearBar){
    clearBar=document.createElement('div');
    clearBar.className='tf-clearbar';
    clearBar.innerHTML=`<span class="tf-clearbar-text"></span><button type="button" class="tf-clearbar-btn">✕ Clear all filters</button>`;
    table.parentNode.insertBefore(clearBar,table);
    clearBar.querySelector('.tf-clearbar-btn').addEventListener('click',()=>{
      Object.keys(activeFilters).forEach(k=>delete activeFilters[k]);
      applyFilters();
    });
  }
  function closeDropdown(){document.querySelectorAll('.tf-dropdown').forEach(d=>{d._cleanup?.();d.remove()})}
  function getColumnValues(colIndex){
    const vals=new Set();
    const otherFilters=Object.entries(activeFilters).filter(([c])=>Number(c)!==colIndex);
    Array.from(tbody.querySelectorAll('tr')).forEach(row=>{
      if(row.classList.contains('tf-nodata')||row.classList.contains('extra-row'))return;
      const passesOthers=otherFilters.every(([c,allowed])=>{
        const val=(row.children[c]?.textContent||'').trim()||'(Blank)';
        return allowed.has(val);
      });
      if(!passesOthers)return;
      vals.add((row.children[colIndex]?.textContent||'').trim()||'(Blank)');
    });
    return Array.from(vals).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true,sensitivity:'base'}));
  }
  function sortByColumn(i,dir){
    cols.forEach(c=>{c.dataset.sortDir='';c.classList.remove('tf-sort-asc','tf-sort-desc')});
    cols[i].dataset.sortDir=dir;cols[i].classList.add(dir==='asc'?'tf-sort-asc':'tf-sort-desc');
    const rows=Array.from(tbody.querySelectorAll('tr')).filter(r=>!r.classList.contains('tf-nodata'));
    rows.sort((a,b)=>{
      const av=(a.children[i]?.textContent||'').trim(),bv=(b.children[i]?.textContent||'').trim();
      const an=parseFloat(av.replace(/,/g,'')),bn=parseFloat(bv.replace(/,/g,''));
      const bothNumeric=av!==''&&bv!==''&&!isNaN(an)&&!isNaN(bn);
      const cmp=bothNumeric?an-bn:av.localeCompare(bv,undefined,{numeric:true,sensitivity:'base'});
      return dir==='asc'?cmp:-cmp;
    });
    rows.forEach(r=>tbody.appendChild(r));
  }
  function applyFilters(){
    const rows=Array.from(tbody.querySelectorAll('tr')).filter(r=>!r.classList.contains('tf-nodata'));
    const activeCount=Object.keys(activeFilters).length,anyFilterActive=activeCount>0;
    let visible=0;
    rows.forEach(row=>{
      const isExtra=row.classList.contains('extra-row');
      const matches=Object.entries(activeFilters).every(([colIdx,allowed])=>{
        const val=(row.children[colIdx]?.textContent||'').trim()||'(Blank)';
        return allowed.has(val);
      });
      if(anyFilterActive)row.style.display=matches?'':'none';
      else row.style.display=(isExtra&&opts.collapsedCheck&&!opts.collapsedCheck())?'none':'';
      if(matches)visible++;
    });
    cols.forEach((th,i)=>{const btn=th.querySelector('.tf-filter-btn');if(btn)btn.classList.toggle('tf-filter-active',!!activeFilters[i])});
    clearBar.classList.toggle('tf-clearbar-visible',anyFilterActive);
    clearBar.querySelector('.tf-clearbar-text').textContent=anyFilterActive?`${activeCount} column filter${activeCount===1?'':'s'} active — showing ${visible} of ${rows.length} rows`:'';
    if(opts.onFilterChange)opts.onFilterChange(anyFilterActive?1:0,visible,rows.length);
  }
  function openDropdown(th,colIndex){
    closeDropdown();
    const btn=th.querySelector('.tf-filter-btn');
    const values=getColumnValues(colIndex);
    const currentAllowed=activeFilters[colIndex]||new Set(values);
    const canSort=!noSortCols.has(colIndex);
    const dd=document.createElement('div');
    dd.className='tf-dropdown';
    dd.innerHTML=(canSort?`<div class="tf-dd-sort"><button type="button" data-sort="asc">⬆ Sort A → Z</button><button type="button" data-sort="desc">⬇ Sort Z → A</button></div>`:'')+
      `<input type="text" class="tf-dd-search" placeholder="Search…">`+
      `<div class="tf-dd-actions"><button type="button" data-act="all">Select All</button><button type="button" data-act="clear">Clear</button></div>`+
      `<div class="tf-dd-list">${values.map(v=>`<label class="tf-dd-item"><input type="checkbox" value="${esc(v)}"${currentAllowed.has(v)?' checked':''}><span>${esc(v)}</span></label>`).join('')||'<div style="padding:8px;color:var(--muted);font-size:11.5px">No values</div>'}</div>`+
      `<div class="tf-dd-footer"><button type="button" class="tf-dd-ok">OK</button><button type="button" class="tf-dd-cancel">Cancel</button></div>`;
    document.body.appendChild(dd);
    positionDropdown(dd,btn);
    const reposition=()=>positionDropdown(dd,btn);
    window.addEventListener('scroll',reposition,true);
    window.addEventListener('resize',reposition);
    const onKeydown=e=>{if(e.key==='Escape'){closeDropdown();btn?.focus()}};
    document.addEventListener('keydown',onKeydown);
    dd._cleanup=()=>{window.removeEventListener('scroll',reposition,true);window.removeEventListener('resize',reposition);document.removeEventListener('keydown',onKeydown)};
    dd.querySelectorAll('[data-sort]').forEach(btn=>btn.addEventListener('click',()=>{sortByColumn(colIndex,btn.dataset.sort);closeDropdown()}));
    const searchInput=dd.querySelector('.tf-dd-search');
    searchInput.addEventListener('input',debounce(()=>{
      const q=searchInput.value.toLowerCase();
      dd.querySelectorAll('.tf-dd-item').forEach(item=>{item.style.display=item.textContent.toLowerCase().includes(q)?'':'none'});
    },120));
    dd.querySelector('[data-act="all"]')?.addEventListener('click',()=>dd.querySelectorAll('.tf-dd-item input').forEach(cb=>cb.checked=true));
    dd.querySelector('[data-act="clear"]')?.addEventListener('click',()=>dd.querySelectorAll('.tf-dd-item input').forEach(cb=>cb.checked=false));
    dd.querySelector('.tf-dd-ok').addEventListener('click',()=>{
      const checked=Array.from(dd.querySelectorAll('.tf-dd-item input:checked')).map(cb=>cb.value);
      if(checked.length===values.length)delete activeFilters[colIndex];else activeFilters[colIndex]=new Set(checked);
      closeDropdown();applyFilters();
    });
    dd.querySelector('.tf-dd-cancel').addEventListener('click',closeDropdown);
    dd.addEventListener('click',e=>e.stopPropagation());
    searchInput.focus();
  }
  if(!document.body.dataset.tfDropdownListener){
    document.body.dataset.tfDropdownListener='1';
    document.addEventListener('click',e=>{if(!e.target.closest('.tf-filter-btn')&&!e.target.closest('.tf-dropdown'))closeDropdown()});
  }
  cols.forEach((th,i)=>{
    th.querySelector('.tf-th-controls')?.remove();
    if(noFilterCols.has(i))return;
    const wrap=document.createElement('span');
    wrap.className='tf-th-controls';
    const btn=document.createElement('button');
    btn.type='button';btn.className='tf-filter-btn';btn.textContent='▾';btn.title='Filter & sort';
    btn.addEventListener('click',ev=>{ev.stopPropagation();openDropdown(th,i)});
    wrap.appendChild(btn);
    th.appendChild(wrap);
  });
  table._tfApplyFilters=applyFilters;
  return applyFilters;
}
function toggleRows(){const rows=[...document.querySelectorAll('.extra-row')],btn=document.getElementById('showMoreBtn');if(!rows.length||!btn)return;const expand=rows[0].style.display==='none';movRowsExpanded=expand;rows.forEach(r=>r.style.display=expand?'':'none');btn.textContent=expand?'Show less ↑':`Show all ${document.querySelectorAll('#movTbody tr').length} records ↓`}
function getExportData(cntr){const d=DATA[cntr];if(!d)return null;const moves=(d.movements||[]).map((m,i)=>[i+1,fmtDatePlain(m.date),m.dock||'',fmtTime(m.start),fmtTime(m.end),fmtDuration(m.duration_minutes),m.seal_type||'',m.carrier||'',m.remarks||'']);const archives=(d.archive_records||[]).map(a=>[cntr,a.size||'',fmtDatePlain(a.gate_in),fmtDatePlain(a.gate_out),a.carrier||'',a.arrived_as||'',a.status||'',a.pic||'',a.seal_num||'',a.seal_photos||'',a.remarks||'',a.source_sheet||'']);const customers=(d.customer_records||[]).map(c=>[cntr,c.size||'',c.carrier||'',c.arrived_as||'',hasValue(c.remaining)?c.remaining:'',c.customer||'',c.status||'',fmtDatePlain(c.date),c.pic||'']);const returns=(d.will_back_records||[]).map(w=>[cntr,w.size||'',fmtDatePlain(w.gate_in),fmtDatePlain(w.gate_out),w.remarks||'']);const cys=(d.cy_records||[]).map(y=>{const det=detentionInfo(y);return[cntr,y.ser||'',y.type||'',y.tare_weight||'',y.term||'',y.arrived_as||'',y.withdrawal_bc||'',fmtDatePlain(y.assignment_date),fmtDatePlain(y.arrival_date),y.terminal||'',y.lsp||'',y.carrier||'',fmtDatePlain(y.deadline),hasValue(y.remaining)?y.remaining:'',y.stuffing_status||'',y.pro_week||'',y.customer||'',y.allocated_bc||'',fmtDatePlain(y.gate_out),fmtDatePlain(y.port_gate_in),hasValue(det.days)?det.days:'',det.status,det.detail,y.remarks||'']});return{moves,archives,customers,returns,cys}}
function xmlEscape(v){return String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function ssCell(v){const n=typeof v==='number';return`<Cell><Data ss:Type="${n?'Number':'String'}">${xmlEscape(v)}</Data></Cell>`}function ssRow(c){return`<Row>${c.map(ssCell).join('')}</Row>`}function ssSheet(name,h,b){return`<Worksheet ss:Name="${xmlEscape(name)}"><Table><Row>${h.map(x=>`<Cell ss:StyleID="Header"><Data ss:Type="String">${xmlEscape(x)}</Data></Cell>`).join('')}</Row>${(b.length?b:[['No records']]).map(ssRow).join('')}</Table></Worksheet>`}
function downloadExcel(cntr){if(!requireExportPermission())return;try{const x=getExportData(cntr),xml=`<?xml version="1.0"?><?mso-application progid="Excel.Sheet"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Styles><Style ss:ID="Header"><Font ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#1B4F8A" ss:Pattern="Solid"/></Style></Styles>${ssSheet('Summary',['Field','Value'],[['Container Number',cntr],['Export Date',new Date().toLocaleString('en-GB')],['Movement Records',x.moves.length],['Archive Records',x.archives.length],['CY Records',x.cys.length]])}${ssSheet('CY Management',['Container','Ser','Type','Tare Weight','Term','Arrived As','Withdrawal BC','Assignment Date','Arrival Date','Terminal','LSP','Carrier','Deadline','Remaining','Stuffing Status','Production Week','Customer','Allocated BC','Gate Out','Gate In to Port','Detention Days','Remarks'],x.cys)}${ssSheet('Archive & Stock',['Container','Size','Gate In','Gate Out','Carrier','Arrived As','Status','PIC','Seal No.','Seal Photos','Remarks','Source Sheet'],x.archives)}${ssSheet('With Customer',['Container','Size','Carrier','Arrived As','Remaining','Customer','Status','Date','PIC'],x.customers)}${ssSheet('Will Back Again',['Container','Size','Gate In','Gate Out','Remarks'],x.returns)}${ssSheet('Movement History',['#','Date','Dock','Start Time','End Time','Duration','Seal Type','Carrier','Remarks'],x.moves)}</Workbook>`;const blob=new Blob([xml],{type:'application/vnd.ms-excel'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`CNTR_${cntr}_${new Date().toISOString().slice(0,10)}.xls`;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);showToast('✅ Excel file downloaded')}catch(e){alert('Export failed: '+e.message)}}
function downloadPDF(cntr){if(!requireExportPermission())return;const d=DATA[cntr],a=d.archive||{},c=d.customer||{},y=d.cy||{},x=getExportData(cntr),det=detentionInfo(y);function table(rows){return`<table class="pdf-info">${rows.map(r=>`<tr><td class="lbl">${xmlEscape(r[0])}</td><td>${xmlEscape(hasValue(r[1])?r[1]:'—')}</td><td class="lbl">${xmlEscape(r[2])}</td><td>${xmlEscape(hasValue(r[3])?r[3]:'—')}</td></tr>`).join('')}</table>`}const cy=hasRecord(d.cy)?`<h3>CY MANAGEMENT</h3>${table([['Status',y.stuffing_status,'Customer',y.customer],['Carrier',y.carrier,'LSP',y.lsp],['Arrival',fmtDatePlain(y.arrival_date),'Deadline',fmtDatePlain(y.deadline)],['Gate In to Port',fmtDatePlain(y.port_gate_in),'Detention Days',hasValue(det.days)?det.days:'—'],['Detention Status',det.status,'Calculation',det.detail],['Remaining',y.remaining,'Withdrawal BC',y.withdrawal_bc],['Allocated BC',y.allocated_bc,'Terminal',y.terminal]])}`:'';const arch=hasRecord(d.archive)?`<h3>ARCHIVE & STOCK</h3>${table([['Size',a.size,'Gate In',fmtDatePlain(a.gate_in)],['Gate Out',fmtDatePlain(a.gate_out),'Carrier',a.carrier],['Status',a.status,'Arrived As',a.arrived_as],['PIC',a.pic,'Seal No.',a.seal_num]])}`:'';const cust=hasRecord(d.customer)?`<h3>WITH CUSTOMER</h3>${table([['Customer',c.customer,'Status',c.status],['Size',c.size,'Carrier',c.carrier],['Arrived As',c.arrived_as,'Remaining',c.remaining],['Date',fmtDatePlain(c.date),'PIC',c.pic]])}`:'';const rows=x.moves.map(r=>`<tr>${r.slice(0,8).map(v=>`<td>${xmlEscape(v)}</td>`).join('')}</tr>`).join('');const doc=`<!doctype html><html><head><meta charset="utf-8"><title>CNTR_${xmlEscape(cntr)}</title><style>@page{size:A4;margin:13mm}body{font-family:Arial;color:#1A2332;font-size:10px}header{background:#0D1B2A;color:white;padding:14px;border-bottom:3px solid #F4A41B}h1{margin:0;font-size:18px}.id{background:#1B4F8A;color:white;padding:10px;margin:12px 0;font-size:18px;font-weight:bold}h3{background:#0D1B2A;color:white;padding:6px;margin:12px 0 0}.pdf-info,.moves{width:100%;border-collapse:collapse}.pdf-info td,.moves td,.moves th{border:1px solid #D8E1EC;padding:5px}.lbl{font-weight:bold;background:#F0F4F8}.moves th{background:#1B4F8A;color:white}</style></head><body><header><h1>CONTAINER REPORT</h1><div>Generated ${new Date().toLocaleString('en-GB')}</div></header><div class="id">${xmlEscape(cntr)} — ${xmlEscape(currentStatus(d))}</div>${cy}${arch}${cust}<h3>MOVEMENT HISTORY (${x.moves.length})</h3><table class="moves"><thead><tr><th>#</th><th>Date</th><th>Dock</th><th>Start</th><th>End</th><th>Duration</th><th>Seal</th><th>Carrier</th></tr></thead><tbody>${rows}</tbody></table><script>window.onload=()=>window.print();<\/script></body></html>`;const win=window.open('','_blank');if(!win)return alert('Please allow pop-ups to print the report.');win.document.write(doc);win.document.close()}
/* ── Always-on debug log (temporary diagnostic aid) ──
   A small floating button that opens a panel listing recent log entries. Captures
   console.error, uncaught errors, and unhandled promise rejections automatically,
   plus explicit dlog() calls from the sync code — so nothing can be silently missed. */
const DEBUG_LOG=[];
function dlog(msg){
  const line=`[${new Date().toLocaleTimeString('en-GB')}] ${msg}`;
  DEBUG_LOG.push(line);
  if(DEBUG_LOG.length>200)DEBUG_LOG.shift();
  const badge=document.getElementById('debugLogBadge');
  if(badge){badge.style.display='flex';badge.textContent=String(DEBUG_LOG.length)}
  const panel=document.getElementById('debugLogPanel');
  if(panel&&panel.style.display!=='none')renderDebugLog();
}
function renderDebugLog(){
  const body=document.getElementById('debugLogBody');if(!body)return;
  body.textContent=DEBUG_LOG.join('\n')||'(no log entries yet)';
  body.scrollTop=body.scrollHeight;
}
window.addEventListener('error',e=>dlog(`❌ JS error: ${e.message} (${e.filename||''}:${e.lineno||''})`));
window.addEventListener('unhandledrejection',e=>dlog(`❌ Unhandled promise rejection: ${e.reason?.message||e.reason}`));
const _origConsoleError=console.error.bind(console);
console.error=(...args)=>{_origConsoleError(...args);try{dlog('❌ console.error: '+args.map(a=>a?.message||a?.code||String(a)).join(' '))}catch(_){}};
function initDebugLogUI(){
  const btn=document.createElement('button');
  btn.id='debugLogToggle';
  btn.textContent='🐞';
  Object.assign(btn.style,{position:'fixed',bottom:'24px',left:'16px',width:'42px',height:'42px',borderRadius:'50%',border:'none',background:'#0D1B2A',color:'#fff',fontSize:'18px',cursor:'pointer',zIndex:'10950',boxShadow:'0 4px 14px rgba(0,0,0,.3)',display:'none'});
  const badge=document.createElement('span');
  badge.id='debugLogBadge';
  Object.assign(badge.style,{position:'absolute',top:'-4px',right:'-4px',background:'#D63B3B',color:'#fff',fontSize:'10px',fontWeight:'800',minWidth:'16px',height:'16px',borderRadius:'8px',display:'none',alignItems:'center',justifyContent:'center',padding:'0 3px'});
  btn.appendChild(badge);
  const panel=document.createElement('div');
  panel.id='debugLogPanel';
  Object.assign(panel.style,{position:'fixed',bottom:'74px',left:'16px',right:'16px',maxWidth:'520px',maxHeight:'50vh',background:'#0D1B2A',color:'#D7E2EF',borderRadius:'12px',boxShadow:'0 12px 32px rgba(0,0,0,.4)',zIndex:'10950',display:'none',flexDirection:'column',overflow:'hidden'});
  panel.innerHTML=`<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid rgba(255,255,255,.12);font-weight:700;font-size:12px">🐞 Debug Log · Yard Operation accounts only<div style="display:flex;gap:8px"><button id="debugLogCopy" style="background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);color:#fff;border-radius:6px;padding:4px 8px;font-size:11px;cursor:pointer">Copy</button><button id="debugLogClear" style="background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);color:#fff;border-radius:6px;padding:4px 8px;font-size:11px;cursor:pointer">Clear</button><button id="debugLogClose" style="background:rgba(214,59,59,.25);border:1px solid rgba(214,59,59,.4);color:#fff;border-radius:6px;padding:4px 8px;font-size:11px;cursor:pointer">✕</button></div></div><pre id="debugLogBody" style="margin:0;padding:12px 14px;font-size:10.5px;line-height:1.5;white-space:pre-wrap;word-break:break-word;overflow-y:auto;flex:1;font-family:'JetBrains Mono',monospace"></pre>`;
  document.body.appendChild(btn);
  document.body.appendChild(panel);
  btn.addEventListener('click',()=>{
    const open=panel.style.display!=='none';
    panel.style.display=open?'none':'flex';
    if(!open){renderDebugLog();badge.style.display='none'}
  });
  document.getElementById('debugLogClose').addEventListener('click',()=>panel.style.display='none');
  document.getElementById('debugLogClear').addEventListener('click',()=>{DEBUG_LOG.length=0;renderDebugLog()});
  document.getElementById('debugLogCopy').addEventListener('click',async()=>{
    try{await navigator.clipboard.writeText(DEBUG_LOG.join('\n'));showToast('📋 Log copied')}
    catch(_){showToast('⚠️ Could not copy — select the text manually')}
  });
  dlog('App booted');
  updateDebugButtonVisibility();
}
function updateDebugButtonVisibility(){
  const btn=document.getElementById('debugLogToggle');
  if(!btn)return;
  const allowed=typeof currentUserIsOperation==='function'&&currentUserIsOperation();
  btn.style.display=allowed?'flex':'none';
  if(!allowed)document.getElementById('debugLogPanel')?.style.setProperty('display','none');
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',initDebugLogUI);else initDebugLogUI();
function showToast(msg){let t=document.getElementById('exportToast');if(!t){t=document.createElement('div');t.id='exportToast';Object.assign(t.style,{position:'fixed',bottom:'24px',right:'24px',maxWidth:'min(90vw,420px)',background:'#0D1B2A',color:'#fff',padding:'12px 20px',borderRadius:'8px',fontSize:'13px',fontWeight:'600',lineHeight:'1.4',boxShadow:'0 8px 24px rgba(0,0,0,.25)',zIndex:'9999',transition:'opacity .3s,transform .3s'});document.body.appendChild(t)}t.textContent=msg;t.style.opacity='1';clearTimeout(t._timer);const dur=/^[⚠️❌]/.test(msg)?7000:3000;t._timer=setTimeout(()=>t.style.opacity='0',dur)}

/* ── LOGIN GATE (multi-user) ──
   This is a single, offline HTML file with no server: accounts are stored
   in this browser's localStorage only (per device, not shared/synced), and
   passwords are one-way hashed with PBKDF2 before being saved — the app
   never keeps a recoverable copy of a password, only its hash. Losing a
   password means resetting it (see the Users panel), not looking it up.
   Container data itself is never embedded in this file: it is only read,
   in memory, from the two Excel workbooks you choose after signing in.
*/
let systemDataLoaded=false;
let selectedSourceFiles={movement:null,management:null};

const movementFileInput=document.getElementById('movementFileInput');
const managementFileInput=document.getElementById('managementFileInput');
const movementFileCard=document.getElementById('movementFileCard');
const managementFileCard=document.getElementById('managementFileCard');
const movementFileName=document.getElementById('movementFileName');
const managementFileName=document.getElementById('managementFileName');
const sourceStatus=document.getElementById('sourceStatus');
const sourceProgress=document.getElementById('sourceProgress');
const loadSourcesBtn=document.getElementById('loadSourcesBtn');
const backToSystemBtn=document.getElementById('backToSystemBtn');
const sourceLogoutBtn=document.getElementById('sourceLogoutBtn');
const changeSourcesBtn=document.getElementById('changeSourcesBtn');

function b64ToBytes(value){
  const raw=atob(value),out=new Uint8Array(raw.length);
  for(let i=0;i<raw.length;i++)out[i]=raw.charCodeAt(i);
  return out;
}
function bytesToB64(bytes){
  let binary='';
  const chunk=0x8000;
  for(let i=0;i<bytes.length;i+=chunk)binary+=String.fromCharCode(...bytes.subarray(i,i+chunk));
  return btoa(binary);
}
function storageGet(key){try{return sessionStorage.getItem(key)}catch(_){return null}}
function storageSet(key,value){try{sessionStorage.setItem(key,value)}catch(_){}}
function storageRemove(key){try{sessionStorage.removeItem(key)}catch(_){}}
function ensureCrypto(){
  if(!window.crypto||!window.crypto.subtle||!window.TextEncoder){
    throw new Error('This browser does not support the login required by this file. Please use the latest Chrome or Edge.');
  }
}
function constantTimeEqual(a,b){
  if(a.length!==b.length)return false;
  let diff=0;for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);return diff===0;
}
function randomSaltB64(){return bytesToB64(crypto.getRandomValues(new Uint8Array(16)))}
async function hashPassword(password,saltB64){
  ensureCrypto();
  const material=await crypto.subtle.importKey('raw',new TextEncoder().encode(String(password)),'PBKDF2',false,['deriveBits']);
  const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt:b64ToBytes(saltB64),iterations:AUTH_PBKDF2_ITERATIONS,hash:'SHA-256'},material,256);
  return bytesToB64(new Uint8Array(bits));
}
const PASSWORD_MIN_LENGTH=8;
function checkPasswordStrength(password){
  const p=String(password||'');
  if(p.length<PASSWORD_MIN_LENGTH)throw new Error(`Password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
  if(!/[a-zA-Z]/.test(p)||!/[0-9]/.test(p))throw new Error('Password must include both letters and numbers.');
}
/* ── Login rate limiting (this device) ──
   Slows down repeated guessing from this browser. Not a substitute for
   server-side protection, but raises the bar for casual brute-forcing. */
const LOGIN_ATTEMPTS_KEY='container_lookup_login_attempts_v1';
const LOGIN_MAX_ATTEMPTS=5,LOGIN_LOCKOUT_MS=60000;
function loadLoginAttempts(){try{return JSON.parse(localStorage.getItem(LOGIN_ATTEMPTS_KEY)||'{}')}catch(_){return{}}}
function saveLoginAttempts(a){try{localStorage.setItem(LOGIN_ATTEMPTS_KEY,JSON.stringify(a))}catch(_){}}
function getLoginLockout(key){
  const rec=loadLoginAttempts()[key];
  if(!rec||rec.count<LOGIN_MAX_ATTEMPTS)return 0;
  const remaining=rec.lockedAt+LOGIN_LOCKOUT_MS-Date.now();
  return remaining>0?remaining:0;
}
function recordLoginFailure(key){
  const all=loadLoginAttempts(),rec=all[key]||{count:0,lockedAt:0};
  rec.count++;
  if(rec.count>=LOGIN_MAX_ATTEMPTS)rec.lockedAt=Date.now();
  all[key]=rec;saveLoginAttempts(all);
}
function clearLoginFailures(key){const all=loadLoginAttempts();delete all[key];saveLoginAttempts(all)}
/* Accounts (regular sign-in users): public profile lives in the cloud when
   Firebase is configured, so a Controller-created account works from any
   device the moment it's created. The password hash/salt is kept in a
   SEPARATE collection (userSecrets) that is never broadcast to every
   visitor — it's fetched one document at a time, only at the moment a
   login/reset actually needs it, and Firestore rules block listing it in
   bulk. Falls back to this-device-only storage otherwise (where this
   split doesn't matter, since nothing leaves the device). */
function loadUsersLocal(){try{return JSON.parse(localStorage.getItem(USERS_STORAGE_KEY)||'{}')}catch(_){return{}}}
function saveUsersLocal(users){try{localStorage.setItem(USERS_STORAGE_KEY,JSON.stringify(users))}catch(_){}}
function loadUsers(){return FIREBASE_ENABLED&&fbReady?USERS_CACHE:loadUsersLocal()}
async function fetchUserSecret(key){
  if(FIREBASE_ENABLED&&fbReady){
    try{const doc=await fbDb.collection('userSecrets').doc(key).get();return doc.exists?doc.data():null}
    catch(err){console.error('Could not fetch credentials',err);return null}
  }
  const local=loadUsersLocal()[key];
  return local?{salt:local.salt,hash:local.hash}:null;
}
async function saveUserRecord(key,userObj){
  const{salt,hash,...publicFields}=userObj;
  if(FIREBASE_ENABLED&&fbReady){
    USERS_CACHE={...USERS_CACHE,[key]:publicFields};
    try{
      const batch=fbDb.batch();
      batch.set(fbDb.collection('users').doc(key),publicFields);
      if(salt&&hash)batch.set(fbDb.collection('userSecrets').doc(key),{salt,hash});
      await batch.commit();
    }catch(err){console.error('Could not sync this account to the cloud',err);throw new Error('Could not save to the cloud — check your internet connection.')}
  }else{
    const users=loadUsersLocal();users[key]=userObj;saveUsersLocal(users);
  }
}
async function deleteUserRecord(key){
  if(FIREBASE_ENABLED&&fbReady){
    const next={...USERS_CACHE};delete next[key];USERS_CACHE=next;
    try{
      const batch=fbDb.batch();
      batch.delete(fbDb.collection('users').doc(key));
      batch.delete(fbDb.collection('userSecrets').doc(key));
      await batch.commit();
    }
    catch(err){console.error('Could not delete this account from the cloud',err);throw new Error('Could not reach the cloud — check your internet connection.')}
  }else{
    const users=loadUsersLocal();delete users[key];saveUsersLocal(users);
  }
}
function userKey(username){return String(username||'').trim().toLowerCase()}
async function createUser(username,password,email,phone,isOperation,extraPerms={}){
  const key=userKey(username);
  if(!key)throw new Error('Enter a username.');
  checkPasswordStrength(password);
  const emailTrim=String(email||'').trim();
  if(emailTrim&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailTrim))throw new Error('Enter a valid email address.');
  const phoneTrim=String(phone||'').trim();
  if(phoneTrim&&!/^[+\d][\d\s-]{5,19}$/.test(phoneTrim))throw new Error('Enter a valid phone number.');
  if(loadUsers()[key])throw new Error('This username already exists.');
  const salt=randomSaltB64();
  const record={username:String(username).trim(),email:emailTrim||null,phone:phoneTrim||null,isOperation:!!isOperation,canExport:!!extraPerms.canExport,canUploadData:!!extraPerms.canUploadData,canViewUsers:!!extraPerms.canViewUsers,salt,hash:await hashPassword(password,salt),createdAt:new Date().toISOString()};
  await saveUserRecord(key,record);
  if(emailTrim){
    try{await createRealAuthAccount(realAuthEmailFor(username,emailTrim),password)}
    catch(err){console.error('Could not create the real-auth account for this user — they will be migrated on first login instead.',err)}
  }
  return record;
}
/* ── Audit log — records who did what to accounts, beyond just yard moves ── */
async function auditLog(action,detail){
  const by=storageGet(AUTH_SESSION_KEY)||'controller';
  if(FIREBASE_ENABLED&&fbReady){
    try{await fbDb.collection('auditLog').add({action,detail:detail||null,by,at:firebase.firestore.FieldValue.serverTimestamp()})}
    catch(err){console.error('Could not write audit log entry',err)}
  }else{
    try{
      const log=JSON.parse(localStorage.getItem('container_lookup_audit_log_v1')||'[]');
      log.unshift({action,detail:detail||null,by,at:new Date().toISOString()});
      localStorage.setItem('container_lookup_audit_log_v1',JSON.stringify(log.slice(0,300)));
    }catch(_){}
  }
}
async function setUserEmail(key,email){
  const trimmed=String(email||'').trim();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed))throw new Error('Enter a valid email address.');
  const user=loadUsers()[key];
  if(!user)throw new Error('User not found.');
  await saveUserRecord(key,{...user,email:trimmed});
  auditLog('add_email',key);
}
async function setUserOperationFlag(key,flag){
  const user=loadUsers()[key];
  if(!user)throw new Error('User not found.');
  await saveUserRecord(key,{...user,isOperation:!!flag});
  auditLog(flag?'grant_operation':'revoke_operation',key);
}
async function setUserPermFlag(key,permName,flag){
  const user=loadUsers()[key];
  if(!user)throw new Error('User not found.');
  await saveUserRecord(key,{...user,[permName]:!!flag});
  auditLog(`${flag?'grant':'revoke'}_${permName}`,key);
}
function currentUserRecord(){
  const session=storageGet(AUTH_SESSION_KEY);
  return session?loadUsers()[session]||null:null;
}
function currentUserCan(permName){
  const user=currentUserRecord();
  return !!(user&&user[permName]);
}
function currentUserIsOperation(){
  const session=storageGet(AUTH_SESSION_KEY);
  if(!session)return false;
  const user=loadUsers()[session];
  return !!(user&&user.isOperation);
}
async function verifyUser(username,password){
  const key=userKey(username);
  const lockout=getLoginLockout(key);
  if(lockout>0)throw new Error(`Too many failed attempts. Try again in ${Math.ceil(lockout/1000)}s.`);
  const user=loadUsers()[key];
  if(!user){recordLoginFailure(key);return false}
  const secret=await fetchUserSecret(key);
  if(!secret){recordLoginFailure(key);return false}
  const ok=constantTimeEqual(await hashPassword(password,secret.salt),secret.hash);
  if(ok)clearLoginFailures(key);else recordLoginFailure(key);
  return ok;
}
async function resetUserPassword(key,newPassword){
  checkPasswordStrength(newPassword);
  const user=loadUsers()[key];
  if(!user)throw new Error('User not found.');
  const salt=randomSaltB64();
  const record={...user,salt,hash:await hashPassword(newPassword,salt),updatedAt:new Date().toISOString()};
  await saveUserRecord(key,record);
  clearLoginFailures(key);
  auditLog('reset_password',key);
  // The client SDK can't overwrite another account's real Firebase Auth password directly —
  // if they've already been migrated, send them a real reset email so they can get back in
  // with the new one, rather than leaving them locked out of their real-auth session.
  let emailSent=false;
  const realEmail=realAuthEmailFor(key,user.email);
  if(realEmail&&FIREBASE_ENABLED&&fbReady){
    try{await secondaryAuth().sendPasswordResetEmail(realEmail);emailSent=true}
    catch(err){console.error('Could not send password-reset email',err)}
  }
  return{emailSent,email:user.email||null};
}
async function deleteUser(key){await deleteUserRecord(key);auditLog('delete_user',key)}

/* ── Controller account (separate from regular sign-in accounts) ──
   Only this single account can open the Manage Users panel. Same
   public/secret split as regular accounts. */
const ADMIN_STORAGE_KEY='container_lookup_admin_v1';
function loadAdminLocal(){try{return JSON.parse(localStorage.getItem(ADMIN_STORAGE_KEY)||'null')}catch(_){return null}}
function saveAdminLocal(admin){try{localStorage.setItem(ADMIN_STORAGE_KEY,JSON.stringify(admin))}catch(_){}}
function loadAdmin(){return FIREBASE_ENABLED&&fbReady?ADMIN_CACHE:loadAdminLocal()}
async function fetchAdminSecret(){
  if(FIREBASE_ENABLED&&fbReady){
    try{const doc=await fbDb.collection('adminSecrets').doc('controller').get();return doc.exists?doc.data():null}
    catch(err){console.error('Could not fetch controller credentials',err);return null}
  }
  const local=loadAdminLocal();
  return local?{salt:local.salt,hash:local.hash}:null;
}
async function saveAdminRecord(admin){
  const{salt,hash,...publicFields}=admin;
  if(FIREBASE_ENABLED&&fbReady){
    ADMIN_CACHE=publicFields;
    try{
      const batch=fbDb.batch();
      batch.set(fbDb.collection('admin').doc('controller'),publicFields);
      if(salt&&hash)batch.set(fbDb.collection('adminSecrets').doc('controller'),{salt,hash});
      await batch.commit();
    }
    catch(err){console.error('Could not sync the controller account to the cloud',err);throw new Error('Could not save to the cloud — check your internet connection.')}
  }else{
    saveAdminLocal(admin);
  }
}
async function createAdmin(username,password){
  if(!String(username||'').trim())throw new Error('Enter a username.');
  checkPasswordStrength(password);
  const salt=randomSaltB64();
  const admin={username:String(username).trim(),salt,hash:await hashPassword(password,salt),createdAt:new Date().toISOString()};
  await saveAdminRecord(admin);
  auditLog('update_controller_credentials',admin.username);
  return admin;
}
async function verifyAdmin(username,password){
  const admin=loadAdmin();
  if(!admin||userKey(username)!==userKey(admin.username))return false;
  const lockout=getLoginLockout('__controller__');
  if(lockout>0)throw new Error(`Too many failed attempts. Try again in ${Math.ceil(lockout/1000)}s.`);
  const secret=await fetchAdminSecret();
  if(!secret){recordLoginFailure('__controller__');return false}
  const ok=constantTimeEqual(await hashPassword(password,secret.salt),secret.hash);
  if(ok)clearLoginFailures('__controller__');else recordLoginFailure('__controller__');
  return ok;
}

/* ══════════════ YARD OPERATIONS DATA LAYER ══════════════
   Container yard locations are operational data layered on top of the
   Excel-derived DATA — they persist independently of Excel reloads.
   Addressing matches the operation team's existing stacking sheets:
   STACK.BAY.ROW/TIER (e.g. A.02.4/3). Cloud-backed (Firestore) when
   configured, with a this-device-only fallback otherwise. */
const YARD_CONFIG_LOCAL_KEY='container_lookup_yard_config_v1';
const YARD_LOCATIONS_LOCAL_KEY='container_lookup_yard_locations_v1';
const STATUS_OVERRIDES_LOCAL_KEY='container_lookup_status_overrides_v1';
let STATUS_OVERRIDES_CACHE={};
function loadStatusOverridesLocal(){try{return JSON.parse(localStorage.getItem(STATUS_OVERRIDES_LOCAL_KEY)||'{}')}catch(_){return{}}}
function saveStatusOverridesLocal(map){try{localStorage.setItem(STATUS_OVERRIDES_LOCAL_KEY,JSON.stringify(map))}catch(_){}}
function loadStatusOverrides(){return FIREBASE_ENABLED&&fbReady?STATUS_OVERRIDES_CACHE:loadStatusOverridesLocal()}
function applyStatusOverrides(){
  if(!DATA)return;
  const overrides=loadStatusOverrides();
  for(const key in overrides){if(DATA[key])DATA[key]._statusOverride=overrides[key].status}
}
const YARD_MOVES_LOCAL_KEY='container_lookup_yard_moves_local_v1';
let YARD_CONFIG_CACHE={stacks:[]},YARD_LOCATIONS_CACHE={},yardListenersStarted=false;

function yardKey(container){return String(container||'').trim().toUpperCase()}
function yardBayLabel(bay){return String(bay).padStart(2,'0')}
/* A handful of exact positions can be permanently disabled (e.g. a crane obstruction over
   one specific bay) rather than a whole row across the stack.
   stack.disabledLocations = [{bay, row, tier}, ...] */
function yardLocationDisabled(stack,bay,row,tier){
  return(stack?.disabledLocations||[]).some(d=>Number(d.bay)===Number(bay)&&Number(d.row)===Number(row)&&Number(d.tier)===Number(tier));
}
function yardBayCapacity(stack,bay){
  let c=stack.rows*stack.tiers;
  if(bay!=null)c-=(stack.disabledLocations||[]).filter(d=>Number(d.bay)===Number(bay)).length;
  return c;
}
function yardStackCapacity(stack){return(stack.bays||[]).reduce((sum,b)=>sum+yardBayCapacity(stack,b),0)}
function yardLocationCode(stackName,bay,row,tier){return `${stackName}${yardBayLabel(bay)}-R${row}-T${tier}`}
function yardSlotTooltip(match){
  const lines=[esc(yardLocationCode(match.stack,match.bay,match.row,match.tier)),esc(match.container)];
  const d=DATA?.[yardKey(match.container)];
  if(d&&!d._yardOnly){
    const arch=d.archive,cust=d.customer,cy=d.cy,moves=d.movements||[];
    const carrier=cy?.carrier||arch?.carrier||cust?.carrier||moves[0]?.carrier;
    const size=cy?.type||arch?.size||cust?.size||moves[0]?.size;
    const status=currentStatus(d);
    if(carrier&&carrier!=='—')lines.push(`Carrier: ${esc(carrier)}`);
    if(size&&size!=='—')lines.push(`Size: ${esc(size)}`);
    if(status&&status!=='—')lines.push(`Status: ${esc(status)}`);
  }
  const days=Math.max(0,Math.round((Date.now()-new Date(match.updatedAt).getTime())/86400000));
  lines.push(`Days at this location: ${days}`);
  return lines.join('\n');
}
function yardColumnOccupancy(stackName,bay,row){
  const col={};
  Object.values(loadYardLocations()).forEach(l=>{
    if(l.stack===stackName&&Number(l.bay)===Number(bay)&&Number(l.row)===Number(row))col[Number(l.tier)]=l;
  });
  return col;
}
function yardContainersAbove(stackName,bay,row,tier){
  const col=yardColumnOccupancy(stackName,bay,row);
  return Object.keys(col).map(Number).filter(t=>t>Number(tier)).sort((a,b)=>b-a).map(t=>col[t]);
}
function yardContainersBelow(stackName,bay,row,tier){
  const col=yardColumnOccupancy(stackName,bay,row);
  return Object.keys(col).map(Number).filter(t=>t<Number(tier)).sort((a,b)=>b-a).map(t=>col[t]);
}
function applyColumnHighlight(row,tier){
  document.querySelectorAll('#yardBayBody [data-yard-slot]').forEach(cell=>{
    const[r,t]=cell.dataset.yardSlot.split('|').map(Number);
    cell.classList.remove('col-selected','col-above','col-below');
    if(r!==Number(row))return;
    const isOccupied=cell.classList.contains('occupied');
    if(t===Number(tier))cell.classList.add('col-selected');
    else if(isOccupied&&t>Number(tier))cell.classList.add('col-above');
    else if(isOccupied&&t<Number(tier))cell.classList.add('col-below');
  });
}
/* Approximate real-world livery colors keyed by the container's 4-letter owner
   prefix (ISO 6346), so the yard map reads like an actual container terminal. */
const CARRIER_LIVERY={
  MSCU:'#F2B705',MSCV:'#F2B705',MEDU:'#F2B705',
  MAEU:'#42A5D6',MRKU:'#42A5D6',MAEI:'#42A5D6',
  CMAU:'#0A3161',CGMU:'#0A3161',CMDU:'#0A3161',
  COSU:'#F4791F',CBHU:'#F4791F',
  HLXU:'#F58220',HLBU:'#F58220',HLCU:'#F58220',
  EGHU:'#1E8A4C',EGSU:'#1E8A4C',EISU:'#1E8A4C',EMCU:'#1E8A4C',
  ONEU:'#C6007E',ONEY:'#C6007E',
  YMLU:'#D9B400',YMLL:'#D9B400',
  HDMU:'#7A1E30',HMMU:'#7A1E30',
  APLU:'#C8102E',APHU:'#C8102E',
  OOLU:'#0091C7',OOCU:'#0091C7',
  ZIMU:'#00539B',ZCSU:'#00539B',
  PONU:'#8B95A1',
  TCLU:'#5B6470',TCNU:'#5B6470',TRIU:'#5B6470',TGHU:'#5B6470',
  WHLU:'#5B6470',CAIU:'#5B6470',FSCU:'#5B6470',TEXU:'#5B6470'
};
function yardCarrierColor(container){const p=String(container||'').toUpperCase().slice(0,4);return CARRIER_LIVERY[p]||'#6E7B8C'}
function yardCarrierTextColor(hex){
  const h=String(hex||'').replace('#','');if(h.length!==6)return'#fff';
  const r=parseInt(h.slice(0,2),16),g=parseInt(h.slice(2,4),16),b=parseInt(h.slice(4,6),16);
  const luminance=(0.299*r+0.587*g+0.114*b)/255;
  return luminance>0.6?'#1A2332':'#fff';
}
function yardLocationLabel(loc){return loc?yardLocationCode(loc.stack,loc.bay,loc.row,loc.tier):'—'}
function loadYardConfigLocal(){try{return JSON.parse(localStorage.getItem(YARD_CONFIG_LOCAL_KEY)||'{"stacks":[]}')}catch(_){return{stacks:[]}}}
function saveYardConfigLocal(cfg){try{localStorage.setItem(YARD_CONFIG_LOCAL_KEY,JSON.stringify(cfg))}catch(_){}}
function loadYardConfig(){return FIREBASE_ENABLED&&fbReady?YARD_CONFIG_CACHE:loadYardConfigLocal()}
async function saveYardConfig(cfg){
  if(FIREBASE_ENABLED&&fbReady){
    YARD_CONFIG_CACHE=cfg;
    try{await fbDb.collection('yardConfig').doc('layout').set(cfg)}
    catch(err){console.error('Could not sync yard layout to the cloud',err);throw new Error('Could not save to the cloud — check your internet connection.')}
  }else{saveYardConfigLocal(cfg)}
}
function loadYardLocationsLocal(){try{return JSON.parse(localStorage.getItem(YARD_LOCATIONS_LOCAL_KEY)||'{}')}catch(_){return{}}}
function saveYardLocationsLocal(locs){try{localStorage.setItem(YARD_LOCATIONS_LOCAL_KEY,JSON.stringify(locs))}catch(_){}}
function loadYardLocations(){return FIREBASE_ENABLED&&fbReady?YARD_LOCATIONS_CACHE:loadYardLocationsLocal()}

async function logYardMove(container,stack,bay,row,tier,note){
  const key=yardKey(container);
  if(!key)throw new Error('Enter a container number.');
  if(!stack||!bay||!row||!tier)throw new Error('Select a stack, bay, row, and tier.');
  const cfg=loadYardConfig(),stackCfg=(cfg?.stacks||[]).find(st=>st.name===stack);
  if(stackCfg&&yardLocationDisabled(stackCfg,bay,row,tier))throw new Error(`${yardLocationCode(stack,bay,row,tier)} is a disabled location — it can't be used.`);
  const locs=loadYardLocations(),prev=locs[key]||null;
  if(Number(tier)>1){
    const below=Object.values(locs).find(l=>l.stack===stack&&Number(l.bay)===Number(bay)&&Number(l.row)===Number(row)&&Number(l.tier)===Number(tier)-1);
    if(!below)throw new Error(`Can't place a container at Tier ${tier} — Tier ${Number(tier)-1} below it is empty at ${yardLocationCode(stack,bay,row,1)}+ (no floating containers allowed).`);
  }
  if(prev){
    const blockers=yardContainersAbove(prev.stack,prev.bay,prev.row,prev.tier);
    if(blockers.length){
      const order=blockers.map(b=>`${b.container} (Tier ${b.tier})`).join(', then ');
      throw new Error(`Container cannot be moved because there are containers stacked above it at ${yardLocationLabel(prev)}. Move first: ${order}.`);
    }
  }
  const record={container:key,stack,bay:String(bay),row:String(row),tier:String(tier),note:String(note||'').trim()||null,updatedAt:new Date().toISOString(),updatedBy:storageGet(AUTH_SESSION_KEY)||'unknown'};
  const posKey=p=>p?`${p.stack}_${p.bay}_${p.row}_${p.tier}`:null;
  const newPosKey=posKey({stack,bay:String(bay),row:String(row),tier:String(tier)});
  if(FIREBASE_ENABLED&&fbReady){
    try{
      // Run the destination-occupancy check AND write inside a single transaction, keyed by the
      // physical slot (not the container), so two simultaneous moves can never both "win" the
      // same slot — Firestore serializes/retries conflicting transactions automatically.
      await fbDb.runTransaction(async tx=>{
        const newPosRef=fbDb.collection('yardPositions').doc(newPosKey);
        const newPosSnap=await tx.get(newPosRef);
        if(newPosSnap.exists&&newPosSnap.data().container!==key){
          throw new Error(`${yardLocationCode(stack,bay,row,tier)} is already occupied by ${newPosSnap.data().container}.`);
        }
        const prevPosRef=prev?fbDb.collection('yardPositions').doc(posKey(prev)):null;
        if(prevPosRef)tx.delete(prevPosRef);
        tx.set(newPosRef,{container:key});
        tx.set(fbDb.collection('yardLocations').doc(key),record);
        tx.set(fbDb.collection('yardMoves').doc(),{
          container:key,
          fromStack:prev?.stack||null,fromBay:prev?.bay||null,fromRow:prev?.row||null,fromTier:prev?.tier||null,
          toStack:stack,toBay:String(bay),toRow:String(row),toTier:String(tier),
          note:record.note,movedBy:record.updatedBy,
          movedAt:firebase.firestore.FieldValue.serverTimestamp()
        });
      });
      YARD_LOCATIONS_CACHE={...YARD_LOCATIONS_CACHE,[key]:record};
    }catch(err){
      console.error('Could not sync this move to the cloud',err);
      if(err?.message?.includes('already occupied'))throw err;
      throw new Error('Could not save to the cloud — check your internet connection.');
    }
  }else{
    const locs=loadYardLocationsLocal();
    const destOccupant=Object.values(locs).find(l=>l.stack===stack&&Number(l.bay)===Number(bay)&&Number(l.row)===Number(row)&&Number(l.tier)===Number(tier));
    if(destOccupant&&destOccupant.container!==key)throw new Error(`${yardLocationCode(stack,bay,row,tier)} is already occupied by ${destOccupant.container}.`);
    locs[key]=record;saveYardLocationsLocal(locs);
    let moves=[];try{moves=JSON.parse(localStorage.getItem(YARD_MOVES_LOCAL_KEY)||'[]')}catch(_){moves=[]}
    moves.unshift({container:key,fromStack:prev?.stack||null,fromBay:prev?.bay||null,fromRow:prev?.row||null,fromTier:prev?.tier||null,toStack:stack,toBay:String(bay),toRow:String(row),toTier:String(tier),note:record.note,movedBy:record.updatedBy,movedAt:record.updatedAt});
    try{localStorage.setItem(YARD_MOVES_LOCAL_KEY,JSON.stringify(moves.slice(0,500)))}catch(_){}
  }
  return record;
}
async function removeYardLocation(container,opts={}){
  const key=yardKey(container);
  if(!key)throw new Error('No container specified.');
  const locs=loadYardLocations(),prev=locs[key];
  if(!prev)throw new Error(`${container} doesn't have a logged yard location.`);
  const by=storageGet(AUTH_SESSION_KEY)||'unknown';
  const status=opts.status||(opts.markLoaded?'IN SIDE FACTORY':null);
  if(FIREBASE_ENABLED&&fbReady){
    try{
      await fbDb.runTransaction(async tx=>{
        const posRef=fbDb.collection('yardPositions').doc(`${prev.stack}_${prev.bay}_${prev.row}_${prev.tier}`);
        const posSnap=await tx.get(posRef);
        if(posSnap.exists&&posSnap.data().container===key)tx.delete(posRef);
        tx.delete(fbDb.collection('yardLocations').doc(key));
        tx.set(fbDb.collection('yardMoves').doc(),{
          container:key,
          fromStack:prev.stack,fromBay:prev.bay,fromRow:prev.row,fromTier:prev.tier,
          toStack:null,toBay:null,toRow:null,toTier:null,
          note:opts.note||(status?`Removed from yard — marked ${status}`:'Removed from yard'),
          movedBy:by,movedAt:firebase.firestore.FieldValue.serverTimestamp()
        });
        if(status)tx.set(fbDb.collection('containerStatusOverrides').doc(key),{status,setAt:firebase.firestore.FieldValue.serverTimestamp(),setBy:by});
      });
      const{[key]:_,...rest}=YARD_LOCATIONS_CACHE;YARD_LOCATIONS_CACHE=rest;
    }catch(err){console.error('Could not remove this location in the cloud',err);throw new Error('Could not save to the cloud — check your internet connection.')}
  }else{
    const localLocs=loadYardLocationsLocal();delete localLocs[key];saveYardLocationsLocal(localLocs);
    let moves=[];try{moves=JSON.parse(localStorage.getItem(YARD_MOVES_LOCAL_KEY)||'[]')}catch(_){moves=[]}
    moves.unshift({container:key,fromStack:prev.stack,fromBay:prev.bay,fromRow:prev.row,fromTier:prev.tier,toStack:null,toBay:null,toRow:null,toTier:null,note:opts.note||'Removed from yard',movedBy:by,movedAt:new Date().toISOString()});
    try{localStorage.setItem(YARD_MOVES_LOCAL_KEY,JSON.stringify(moves.slice(0,500)))}catch(_){}
    if(status){const overrides=loadStatusOverridesLocal();overrides[key]={status,setAt:new Date().toISOString(),setBy:by};saveStatusOverridesLocal(overrides)}
  }
  if(status&&DATA?.[key])DATA[key]._statusOverride=status;
  return prev;
}
async function getYardMoveHistory(container){
  const key=yardKey(container);
  if(FIREBASE_ENABLED&&fbReady){
    try{
      const snap=await fbDb.collection('yardMoves').where('container','==',key).limit(30).get();
      return snap.docs.map(d=>d.data()).sort((a,b)=>(b.movedAt?.toMillis?.()||0)-(a.movedAt?.toMillis?.()||0));
    }catch(err){console.error('Could not load move history',err);return[]}
  }
  try{return(JSON.parse(localStorage.getItem(YARD_MOVES_LOCAL_KEY)||'[]')).filter(m=>m.container===key).slice(0,30)}
  catch(_){return[]}
}
function mergeYardOnlyContainers(){
  if(!DATA)return false;
  const locs=loadYardLocations();
  let changed=false;
  for(const key of Object.keys(locs)){
    if(key&&!DATA[key]){DATA[key]={_yardOnly:true};changed=true}
  }
  if(changed){KEYS=Object.keys(DATA).sort();SEARCH_INDEX=KEYS.map(buildSearchIndexRecord)}
  return changed;
}
function listenYardData(){
  if(!FIREBASE_ENABLED||!fbReady||yardListenersStarted)return;
  yardListenersStarted=true;
  fbDb.collection('yardConfig').doc('layout').onSnapshot(doc=>{
    YARD_CONFIG_CACHE=doc.exists?doc.data():{stacks:[]};
    if(document.getElementById('yardOverlay')?.classList.contains('open'))refreshYardModal();
  },err=>console.error('yard config sync error',err));
  fbDb.collection('yardLocations').onSnapshot(snap=>{
    const next={};snap.forEach(doc=>{next[doc.id]=doc.data()});
    YARD_LOCATIONS_CACHE=next;
    if(systemDataLoaded)mergeYardOnlyContainers();
    if(document.getElementById('yardOverlay')?.classList.contains('open'))refreshYardModal();
  },err=>console.error('yard locations sync error',err));
  fbDb.collection('containerStatusOverrides').onSnapshot(snap=>{
    const next={};snap.forEach(doc=>{next[doc.id]=doc.data()});
    STATUS_OVERRIDES_CACHE=next;
    applyStatusOverrides();
  },err=>console.error('status override sync error',err));
}

const XML_NS='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS='http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function cleanCell(v){
  if(!hasValue(v))return null;
  const text=normalizeText(v);
  if(/^#(N\/A|REF!|VALUE!|DIV\/0!|NAME\?|NUM!|NULL!|SPILL!|CALC!|GETTING_DATA)/i.test(text))return null;
  return typeof v==='string'?text:v;
}
function normCarrier(v){
  const text=normalizeText(v);if(!text)return null;
  const upper=text.toUpperCase();
  const map={'TRANSMAR':'Transmar','YANG MING':'YANG MING','MAERSK':'MAERSK','MSC':'MSC','MEDKON EXW':'MEDKON EXW','MEDKON':'MEDKON','MLH EXW':'MLH EXW','LOCAL':'LOCAL','SOC':'SOC','ARKAS':'ARKAS','ESL':'ESL','ONE':'ONE'};
  return map[upper]||text;
}
function asNumber(v){
  if(!hasValue(v))return null;
  const n=Number(typeof v==='string'?v.replace(/,/g,'').trim():v);
  return Number.isFinite(n)?n:null;
}
function excelDate(v,date1904=false){
  if(!hasValue(v))return null;
  if(v instanceof Date&&!Number.isNaN(v.getTime()))return v.toISOString().slice(0,19);
  const raw=typeof v==='string'?normalizeText(v):v;
  const numeric=typeof raw==='number'||(typeof raw==='string'&&/^[-+]?\d+(?:\.\d+)?$/.test(raw));
  if(numeric){
    const n=Number(raw);
    if(!Number.isFinite(n)||n<=0||n>2958465)return null;
    const base=date1904?Date.UTC(1904,0,1):Date.UTC(1899,11,30);
    return new Date(base+Math.round(n*86400000)).toISOString().slice(0,19);
  }
  const text=String(raw).trim();
  let m=text.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if(m){
    const d=new Date(Date.UTC(+m[1],+m[2]-1,+m[3],+(m[4]||0),+(m[5]||0),+(m[6]||0)));
    return Number.isNaN(d.getTime())?text:d.toISOString().slice(0,19);
  }
  m=text.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if(m){
    let year=+m[3];if(year<100)year+=year>=70?1900:2000;
    const d=new Date(Date.UTC(year,+m[2]-1,+m[1],+(m[4]||0),+(m[5]||0),+(m[6]||0)));
    return Number.isNaN(d.getTime())?text:d.toISOString().slice(0,19);
  }
  const parsed=new Date(text);
  return Number.isNaN(parsed.getTime())?text:parsed.toISOString().slice(0,19);
}
function calcDurationMinutes(start,end,fallbackDays){
  const fallback=asNumber(fallbackDays);
  if(fallback!==null)return Math.max(0,Math.round(fallback*1440));
  const s=parseDate(start),e=parseDate(end);return s&&e?Math.max(0,Math.round((e-s)/60000)):null;
}
function completeness(obj){return Object.entries(obj||{}).filter(([k,v])=>!k.startsWith('_')&&hasValue(v)).length}
function latestRecord(records,dateFields){
  if(!records?.length)return null;
  return records.slice().sort((a,b)=>{
    const da=dateFields.map(f=>parseDate(a[f])).find(Boolean)?.getTime()||0;
    const db=dateFields.map(f=>parseDate(b[f])).find(Boolean)?.getTime()||0;
    return (db-da)||(Number(b._source_row||0)-Number(a._source_row||0))||(completeness(b)-completeness(a));
  })[0];
}
function blankish(v){
  if(!hasValue(v))return true;
  if(typeof v==='number')return v===0;
  const x=normalizeText(v).toUpperCase();
  return !x||['-','—','N/A','NA','NULL','NONE','NOT AVAILABLE','(BLANK)','BLANK'].includes(x);
}
function headerKey(v){
  return normalizeText(v).toUpperCase().replace(/&/g,' AND ').replace(/#/g,'').replace(/[^A-Z0-9]+/g,' ').trim().replace(/\s+/g,' ');
}
function sheetKey(v){return headerKey(v).replace(/\bAND\b/g,'').replace(/\s+/g,'')}
function findSheetName(names,candidates){
  const indexed=names.map(name=>({name,key:sheetKey(name)}));
  for(const candidate of candidates){const key=sheetKey(candidate),hit=indexed.find(x=>x.key===key);if(hit)return hit.name}
  return null;
}
function compileSchema(schema){
  const out={};for(const [field,aliases] of Object.entries(schema))out[field]=new Set(aliases.map(headerKey));return out;
}
function findTable(rows,schema,required,label,maxScan=80){
  const compiled=compileSchema(schema);let best=null;
  for(let i=0;i<Math.min(rows.length,maxScan);i++){
    const row=rows[i]||[],map={};
    for(let col=0;col<row.length;col++){
      const key=headerKey(row[col]);if(!key)continue;
      for(const [field,aliases] of Object.entries(compiled))if(map[field]===undefined&&aliases.has(key)){map[field]=col;break}
    }
    const requiredFound=required.filter(field=>map[field]!==undefined).length;
    const score=requiredFound*100+Object.keys(map).length;
    if(!best||score>best.score)best={headerIndex:i,map,score,requiredFound};
    if(requiredFound===required.length&&Object.keys(map).length>=Math.min(Object.keys(schema).length,required.length+4)){best={headerIndex:i,map,score,requiredFound};break}
  }
  if(!best||best.requiredFound<required.length){
    const missing=required.filter(field=>best?.map?.[field]===undefined).map(field=>schema[field][0]);
    throw new Error(`${label}: required column${missing.length===1?' is':'s are'} missing: ${missing.join(', ')}`);
  }
  return{headerIndex:best.headerIndex,map:best.map,dataRows:rows.slice(best.headerIndex+1)};
}
function cell(row,map,field){const index=map[field];return index===undefined?null:row?.[index]}
function rowHasContainer(row,map){return !!normalizeContainer(cleanCell(cell(row,map,'cntr')))}

const RAW_SCHEMA={
  num:['NUM','NO','SER','SR'],cntr:['CNTR','CNTRS','CNTR NO','CONTAINER','CONTAINER NO','CONTAINER NUMBER'],size:['SIZE','TYPE'],carrier:['CARRIER','LINE'],dock:['DOCK'],date:['DATE','MOVEMENT DATE','MOVE DATE'],start:['MOVE START TIME','MOVEMENT START TIME','START TIME','MOVE START'],end:['MOVE END TIME','MOVEMENT END TIME','END TIME','MOVE END'],duration:['DURATION','DURATION DAYS','MOVE DURATION'],seal_type:['SEAL TYPE','SEAL STATUS'],remarks:['REMARKS','REMARK']
};
const ARCHIVE_SCHEMA={
  num:['NO','NUM','SER','SR'],cntr:['CNTRS','CNTR','CNTR NO','CONTAINER','CONTAINER NO'],size:['SIZE','TYPE'],gate_in:['GATE IN DATE','GATE IN','GATEIN DATE'],carrier:['CARRIER','LINE'],arrived_as:['ARRIVED AS','ARRIVEDAS'],status:['STATUS','STUFFING STATUS'],gate_out:['GATE OUT','GATE OUT DATE','GATEOUT'],pic:['PIC','P I C'],seal_num:['SEAL NUM','SEAL NO','SEAL NUMBER'],seal_photos:['SEAL PHOTOS Y N','SEAL PHOTOS','SEAL PHOTO'],remarks:['REMARKS','REMARK']
};
const CUSTOMER_SCHEMA={
  cntr:['CNTRS','CNTR','CNTR NO','CONTAINER'],size:['SIZE','TYPE'],arrived_as:['ARRIVED AS'],remaining:['REMAINING'],carrier:['CARRIER'],customer:['CUSTOMER','CUSTOMER NAME'],status:['STATUS','STUFFING STATUS'],date:['DATE','ASSIGNMENT DATE'],pic:['PIC']
};
const RETURN_SCHEMA={
  cntr:['CNTRS','CNTR','CNTR NO','CONTAINER'],size:['SIZE','TYPE'],gate_in:['GATE IN','GATE IN DATE'],gate_out:['GATE OUT','GATE OUT DATE'],remarks:['REMARKS','REMARK']
};
const CY_SCHEMA={
  ser:['SER','SR','NO','NUM'],cntr:['CNTR','CNTRS','CNTR NO','CONTAINER','CONTAINER NO'],type:['TYPE','SIZE'],tare_weight:['TARE WEIGHT','TARE WT'],term:['TERM','INCOTERM'],arrived_as:['ARRIVED AS'],withdrawal_bc:['WITHDRAWAL BC','WITHDRAWAL BC NO','BC'],assignment_date:['WITHDRAWAL ASSIGNMENT DATE','WITHDRAWAL DATE','ASSIGNMENT DATE'],arrival_date:['ARRIVAL DATE'],terminal:['WITHDRAWAL TERMINAL','TERMINAL'],lsp:['LSP'],carrier:['CARRIER','LINE'],deadline:['DEADLINE TO RETURN TO POL','DEADLINE TO POL','DEADLINE'],remaining:['REMAINING','DAYS REMAINING'],stuffing_status:['STUFFING STATUS','STATUS'],pro_week:['PRO WEEK','PRODUCTION WEEK','PRO WEEK NO'],customer:['CUSTOMER','CUSTOMER NAME'],allocated_bc:['ALLOCATED BC NO','ALLOCATED BC','ALLOCATED BOOKING'],gate_out:['GATE OUT DATE','GATE OUT'],port_gate_in:['GATE IN TO PORT','PORT GATE IN','GATE IN PORT'],detention_days:['DETENTION DAYS','DETENTION DAY'],remarks:['REMARKS','REMARK']
};
function ensureContainer(cntr){
  const key=normalizeContainer(cntr);if(!key)return null;
  if(!DATA[key])DATA[key]={archive:null,archive_records:[],movements:[],customer:null,customer_records:[],will_back:null,will_back_records:[],cy:null,cy_records:[],quality:[],long_movements:0,sources:{}};
  return DATA[key];
}

class ZipReader{
  constructor(buffer){this.buffer=buffer;this.u8=new Uint8Array(buffer);this.dv=new DataView(buffer);this.decoder=new TextDecoder('utf-8');this.entries=this._readDirectory()}
  _u16(offset){return this.dv.getUint16(offset,true)}
  _u32(offset){return this.dv.getUint32(offset,true)}
  _readDirectory(){
    const min=Math.max(0,this.u8.length-65557);let eocd=-1;
    for(let i=this.u8.length-22;i>=min;i--){if(this._u32(i)===0x06054b50){eocd=i;break}}
    if(eocd<0)throw new Error('Invalid XLSX file: ZIP directory was not found.');
    const count=this._u16(eocd+10),offset=this._u32(eocd+16),entries={};let pos=offset;
    for(let i=0;i<count;i++){
      if(this._u32(pos)!==0x02014b50)throw new Error('Invalid XLSX central directory.');
      const method=this._u16(pos+10),compSize=this._u32(pos+20),uncompSize=this._u32(pos+24),nameLen=this._u16(pos+28),extraLen=this._u16(pos+30),commentLen=this._u16(pos+32),localOffset=this._u32(pos+42);
      const name=this.decoder.decode(this.u8.slice(pos+46,pos+46+nameLen));
      entries[name]={method,compSize,uncompSize,localOffset};pos+=46+nameLen+extraLen+commentLen;
    }
    return entries;
  }
  has(name){return !!this.entries[name]}
  async bytes(name){
    const entry=this.entries[name];if(!entry)throw new Error(`Missing XLSX part: ${name}`);
    const pos=entry.localOffset;if(this._u32(pos)!==0x04034b50)throw new Error('Invalid XLSX local header.');
    const nameLen=this._u16(pos+26),extraLen=this._u16(pos+28),start=pos+30+nameLen+extraLen;
    const raw=this.u8.slice(start,start+entry.compSize);
    if(entry.method===0)return raw;
    if(entry.method!==8)throw new Error(`Unsupported XLSX compression method: ${entry.method}`);
    if(typeof DecompressionStream==='undefined')throw new Error('This browser cannot read XLSX files. Use the latest Chrome or Edge.');
    const stream=new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  async text(name){return this.decoder.decode(await this.bytes(name))}
}
function xmlDoc(text){
  const doc=new DOMParser().parseFromString(text,'application/xml');
  if(doc.getElementsByTagName('parsererror')[0])throw new Error('Invalid XML inside the XLSX file.');
  return doc;
}
function relPath(base,target){
  if(target.startsWith('/'))return target.slice(1);
  const parts=(base+'/'+target).split('/'),out=[];
  for(const part of parts){if(!part||part==='.')continue;if(part==='..')out.pop();else out.push(part)}
  return out.join('/');
}
function columnIndex(ref){
  const match=String(ref||'A1').match(/^([A-Z]+)/i);let n=0;
  for(const char of(match?match[1].toUpperCase():'A'))n=n*26+char.charCodeAt(0)-64;
  return n-1;
}
async function openXlsx(buffer){
  const zip=new ZipReader(buffer),shared=[];
  if(zip.has('xl/sharedStrings.xml')){
    const doc=xmlDoc(await zip.text('xl/sharedStrings.xml'));
    for(const item of doc.getElementsByTagNameNS(XML_NS,'si')){
      const parts=[];for(const node of item.getElementsByTagNameNS(XML_NS,'t'))parts.push(node.textContent||'');shared.push(parts.join(''));
    }
  }
  const workbook=xmlDoc(await zip.text('xl/workbook.xml'));
  const workbookPr=workbook.getElementsByTagNameNS(XML_NS,'workbookPr')[0];
  const date1904=workbookPr?.getAttribute('date1904')==='1'||workbookPr?.getAttribute('date1904')==='true';
  const relDoc=xmlDoc(await zip.text('xl/_rels/workbook.xml.rels'));
  const rels={};for(const rel of relDoc.getElementsByTagName('Relationship'))rels[rel.getAttribute('Id')]=rel.getAttribute('Target');
  const sheets={};
  for(const sheet of workbook.getElementsByTagNameNS(XML_NS,'sheet')){
    const name=sheet.getAttribute('name'),rid=sheet.getAttributeNS(REL_NS,'id')||sheet.getAttribute('r:id');
    sheets[name]=relPath('xl',rels[rid]);
  }
  const cache={};
  return{
    names:Object.keys(sheets),date1904,
    async sheet(name){
      if(cache[name])return cache[name];
      if(!sheets[name])throw new Error(`Required worksheet "${name}" was not found.`);
      const doc=xmlDoc(await zip.text(sheets[name])),rows=[];
      for(const rowEl of doc.getElementsByTagNameNS(XML_NS,'row')){
        const row=[];
        for(const cellEl of rowEl.getElementsByTagNameNS(XML_NS,'c')){
          const index=columnIndex(cellEl.getAttribute('r')),type=cellEl.getAttribute('t');let value=null;
          if(type==='inlineStr'){
            const parts=[];for(const node of cellEl.getElementsByTagNameNS(XML_NS,'t'))parts.push(node.textContent||'');value=parts.join('');
          }else{
            const valueEl=cellEl.getElementsByTagNameNS(XML_NS,'v')[0];
            if(valueEl){
              const raw=valueEl.textContent;
              if(type==='s')value=shared[Number(raw)]??raw;
              else if(type==='b')value=raw==='1';
              else if(type==='e')value=null;
              else if(type==='str'||type==='d')value=raw;
              else{const num=Number(raw);value=Number.isFinite(num)?num:raw}
            }
          }
          row[index]=value;
        }
        if(row.some(hasValue))rows.push(row);
      }
      cache[name]=rows;return rows;
    }
  };
}

function parsePivotStats(rows){
  const empty={final:0,half:0,local:0,total:0};if(!rows?.length)return empty;
  let best=null;
  for(let i=0;i<Math.min(rows.length,80);i++){
    const grandIndexes=[];for(let j=0;j<(rows[i]?.length||0);j++)if(headerKey(rows[i][j])==='GRAND TOTAL')grandIndexes.push(j);
    for(const grandIndex of grandIndexes){
      const valueFor=label=>{const row=rows.find((r,k)=>k>i&&headerKey(r?.[0])===label);return row?asNumber(row[grandIndex])||0:0};
      const candidate={final:valueFor('FINAL SEAL'),half:valueFor('HALF SEAL'),local:valueFor('LOCAL'),total:valueFor('GRAND TOTAL')};
      const score=Object.values(candidate).filter(v=>v>0).length*100+candidate.total;
      if(!best||score>best.score)best={...candidate,score};
    }
  }
  return best?{final:best.final,half:best.half,local:best.local,total:best.total}:empty;
}
function deriveOperationalStats(archiveTable){
  const stats={final:0,half:0,local:0,total:0};
  for(const row of archiveTable.dataRows){
    const cntr=normalizeContainer(cleanCell(cell(row,archiveTable.map,'cntr')));if(!cntr)continue;
    const gateOut=cleanCell(cell(row,archiveTable.map,'gate_out'));if(!blankish(gateOut))continue;
    stats.total++;
    const status=normStatus(cleanCell(cell(row,archiveTable.map,'status')));
    if(status==='FINAL SEAL')stats.final++;
    else if(status==='HALF SEAL')stats.half++;
    else if(status==='LOCAL')stats.local++;
  }
  return stats;
}
function optionalTable(rows,schema,required,label){
  if(!rows?.length)return null;
  try{return findTable(rows,schema,required,label)}catch(error){return null}
}

async function ingestMovementWorkbook(buffer){
  const workbook=await openXlsx(buffer);
  const rawName=findSheetName(workbook.names,['Raw Data','Movement Raw Data','CNTR Movement Raw Data']);
  const archiveName=findSheetName(workbook.names,['Archive & Stock','Archive and Stock','Archive Stock']);
  if(!rawName||!archiveName){
    const missing=[];if(!rawName)missing.push('Raw Data');if(!archiveName)missing.push('Archive & Stock');
    throw new Error(`The selected CNTR Movement file is missing worksheet${missing.length>1?'s':''}: ${missing.join(', ')}`);
  }
  const customerName=findSheetName(workbook.names,['CNTRs With Customers','CNTR With Customers','Containers With Customers']);
  const returnName=findSheetName(workbook.names,['CNTRS Will Back Again','CNTRs Will Back Again','Containers Will Back Again']);
  const pivotName=findSheetName(workbook.names,['Pivot Table','PivotTable']);
  const [rawRows,archiveRows,customerRows,returnRows,pivotRows]=await Promise.all([
    workbook.sheet(rawName),workbook.sheet(archiveName),customerName?workbook.sheet(customerName):[],returnName?workbook.sheet(returnName):[],pivotName?workbook.sheet(pivotName):[]
  ]);
  const raw=findTable(rawRows,RAW_SCHEMA,['cntr','date','seal_type'],`${rawName} worksheet`);
  const archive=findTable(archiveRows,ARCHIVE_SCHEMA,['cntr','status','gate_out'],`${archiveName} worksheet`);
  const customers=optionalTable(customerRows,CUSTOMER_SCHEMA,['cntr'],`${customerName||'CNTRs With Customers'} worksheet`);
  const willBack=optionalTable(returnRows,RETURN_SCHEMA,['cntr'],`${returnName||'CNTRS Will Back Again'} worksheet`);
  let movementCount=0,archiveCount=0,customerCount=0,returnCount=0;
  archive.dataRows.forEach((row,index)=>{
    const key=normalizeContainer(cleanCell(cell(row,archive.map,'cntr')));if(!key)return;const data=ensureContainer(key);
    data.archive_records.push({
      size:cleanCell(cell(row,archive.map,'size')),gate_in:excelDate(cleanCell(cell(row,archive.map,'gate_in')),workbook.date1904),carrier:normCarrier(cleanCell(cell(row,archive.map,'carrier'))),arrived_as:cleanCell(cell(row,archive.map,'arrived_as')),status:normStatus(cleanCell(cell(row,archive.map,'status'))),gate_out:excelDate(cleanCell(cell(row,archive.map,'gate_out')),workbook.date1904),pic:normalizeText(cleanCell(cell(row,archive.map,'pic'))),seal_num:cleanCell(cell(row,archive.map,'seal_num')),seal_photos:cleanCell(cell(row,archive.map,'seal_photos')),remarks:cleanCell(cell(row,archive.map,'remarks')),source_sheet:archiveName,_source_row:archive.headerIndex+2+index
    });
    data.sources.movement=true;archiveCount++;
  });
  raw.dataRows.forEach((row,index)=>{
    const key=normalizeContainer(cleanCell(cell(row,raw.map,'cntr')));if(!key)return;const data=ensureContainer(key);
    const start=excelDate(cleanCell(cell(row,raw.map,'start')),workbook.date1904),end=excelDate(cleanCell(cell(row,raw.map,'end')),workbook.date1904);
    data.movements.push({num:asNumber(cell(row,raw.map,'num')),size:cleanCell(cell(row,raw.map,'size')),carrier:normCarrier(cleanCell(cell(row,raw.map,'carrier'))),dock:normStatus(cleanCell(cell(row,raw.map,'dock'))),date:excelDate(cleanCell(cell(row,raw.map,'date')),workbook.date1904),start,end,duration_minutes:calcDurationMinutes(start,end,cell(row,raw.map,'duration')),seal_type:normStatus(cleanCell(cell(row,raw.map,'seal_type'))),remarks:cleanCell(cell(row,raw.map,'remarks')),_source_row:raw.headerIndex+2+index});
    data.sources.movement=true;movementCount++;
  });
  if(customers)customers.dataRows.forEach((row,index)=>{
    const key=normalizeContainer(cleanCell(cell(row,customers.map,'cntr')));if(!key)return;const data=ensureContainer(key);
    data.customer_records.push({size:cleanCell(cell(row,customers.map,'size')),arrived_as:cleanCell(cell(row,customers.map,'arrived_as')),remaining:cleanCell(cell(row,customers.map,'remaining')),carrier:normCarrier(cleanCell(cell(row,customers.map,'carrier'))),customer:cleanCell(cell(row,customers.map,'customer')),status:normStatus(cleanCell(cell(row,customers.map,'status'))),date:excelDate(cleanCell(cell(row,customers.map,'date')),workbook.date1904),pic:cleanCell(cell(row,customers.map,'pic')),_source_row:customers.headerIndex+2+index});
    data.sources.movement=true;customerCount++;
  });
  if(willBack)willBack.dataRows.forEach((row,index)=>{
    const key=normalizeContainer(cleanCell(cell(row,willBack.map,'cntr')));if(!key)return;const data=ensureContainer(key);
    data.will_back_records.push({size:cleanCell(cell(row,willBack.map,'size')),gate_in:excelDate(cleanCell(cell(row,willBack.map,'gate_in')),workbook.date1904),gate_out:excelDate(cleanCell(cell(row,willBack.map,'gate_out')),workbook.date1904),remarks:cleanCell(cell(row,willBack.map,'remarks')),_source_row:willBack.headerIndex+2+index});
    data.sources.movement=true;returnCount++;
  });
  const derivedStats=deriveOperationalStats(archive),cachedPivot=parsePivotStats(pivotRows);
  return{
    movementRows:movementCount,archiveRows:archiveCount,customerRows:customerCount,returnRows:returnCount,
    pivotStats:derivedStats,cachedPivotStats:cachedPivot,
    diagnostics:{rawHeaderRow:raw.headerIndex+1,archiveHeaderRow:archive.headerIndex+1,rawColumns:Object.keys(raw.map),archiveColumns:Object.keys(archive.map)}
  };
}

function findReportDate(rows,headerIndex,date1904){
  for(let i=0;i<=Math.min(headerIndex,10);i++){
    const row=rows[i]||[];
    for(let j=0;j<row.length;j++)if(headerKey(row[j])==='DATE'){
      for(let k=j+1;k<row.length;k++){const result=excelDate(cleanCell(row[k]),date1904);if(result)return result.slice(0,10)}
    }
  }
  return null;
}
async function ingestManagementWorkbook(buffer){
  const workbook=await openXlsx(buffer);
  const cyName=findSheetName(workbook.names,['CY Management','CYManagement','CY Management Report']);
  if(!cyName)throw new Error('The selected file does not contain the required "CY Management" worksheet.');
  const rows=await workbook.sheet(cyName);
  const table=findTable(rows,CY_SCHEMA,['cntr','deadline'],`${cyName} worksheet`,120);let cyRows=0;
  table.dataRows.forEach((row,index)=>{
    const key=normalizeContainer(cleanCell(cell(row,table.map,'cntr')));if(!key)return;const data=ensureContainer(key);
    data.cy_records.push({
      ser:cleanCell(cell(row,table.map,'ser')),type:cleanCell(cell(row,table.map,'type')),tare_weight:cleanCell(cell(row,table.map,'tare_weight')),term:cleanCell(cell(row,table.map,'term')),arrived_as:cleanCell(cell(row,table.map,'arrived_as')),withdrawal_bc:cleanCell(cell(row,table.map,'withdrawal_bc')),assignment_date:excelDate(cleanCell(cell(row,table.map,'assignment_date')),workbook.date1904),arrival_date:excelDate(cleanCell(cell(row,table.map,'arrival_date')),workbook.date1904),terminal:cleanCell(cell(row,table.map,'terminal')),lsp:cleanCell(cell(row,table.map,'lsp')),carrier:normCarrier(cleanCell(cell(row,table.map,'carrier'))),deadline:excelDate(cleanCell(cell(row,table.map,'deadline')),workbook.date1904),remaining:cleanCell(cell(row,table.map,'remaining')),stuffing_status:normStatus(cleanCell(cell(row,table.map,'stuffing_status'))),pro_week:cleanCell(cell(row,table.map,'pro_week')),customer:cleanCell(cell(row,table.map,'customer')),allocated_bc:cleanCell(cell(row,table.map,'allocated_bc')),gate_out:excelDate(cleanCell(cell(row,table.map,'gate_out')),workbook.date1904),port_gate_in:excelDate(cleanCell(cell(row,table.map,'port_gate_in')),workbook.date1904),detention_days:asNumber(cell(row,table.map,'detention_days')),remarks:cleanCell(cell(row,table.map,'remarks')),_source_row:table.headerIndex+2+index
    });
    data.sources.management=true;cyRows++;
  });
  const reportDate=findReportDate(rows,table.headerIndex,workbook.date1904);
  return{cyRows,reportDate,diagnostics:{cyHeaderRow:table.headerIndex+1,cyColumns:Object.keys(table.map)}};
}

function finalizeDynamicData(counts,sourceNames){
  for(const [key,data] of Object.entries(DATA)){
    data.archive=latestRecord(data.archive_records,['gate_out','gate_in']);
    data.cy=latestRecord(data.cy_records,['gate_out','assignment_date','arrival_date']);
    data.customer=latestRecord(data.customer_records,['date']);
    data.will_back=latestRecord(data.will_back_records,['gate_out','gate_in']);
    if(data.cy){
      // The CY Management sheet's "Stuffing Status" is normally a VLOOKUP that
      // pulls the status from Archive & Stock — but Excel only refreshes that
      // cross-workbook formula while BOTH files are open at once, so the saved
      // value can go stale. Since this system reads both workbooks directly
      // anyway, compute it the same way ourselves so it's always current.
      // Clone first so the raw cy_records entry (used in exports) stays untouched.
      const cy={...data.cy};
      if(data.archive?.status)cy.stuffing_status=data.archive.status;
      data.cy=cy;
    }
    if(data.customer){
      // Clone before filling gaps so the original entry inside customer_records
      // (used for the "With Customer" export) is never contaminated with
      // values borrowed from CY / Archive / Movements.
      const cy=data.cy,archive=data.archive,customer={...data.customer};
      customer.size=customer.size??cy?.type??archive?.size??data.movements[0]?.size??null;
      customer.arrived_as=customer.arrived_as??cy?.arrived_as??archive?.arrived_as??null;
      customer.remaining=customer.remaining??cy?.remaining??null;
      customer.carrier=customer.carrier??cy?.carrier??archive?.carrier??data.movements[0]?.carrier??null;
      customer.customer=customer.customer??cy?.customer??null;
      customer.status=customer.status??archive?.status??cy?.stuffing_status??null;
      customer.date=customer.date??cy?.assignment_date??null;
      data.customer=customer;
    }
    // Same idea for movements: build enriched copies rather than mutating the
    // originally-parsed rows in place.
    data.movements=data.movements.map(movement=>({
      ...movement,
      size:movement.size??data.archive?.size??data.cy?.type??data.customer?.size??null,
      carrier:movement.carrier??data.archive?.carrier??data.cy?.carrier??data.customer?.carrier??null
    }));
    data.movements.sort((a,b)=>(parseDate(a.date)?.getTime()||0)-(parseDate(b.date)?.getTime()||0)||(parseDate(a.start)?.getTime()||0)-(parseDate(b.start)?.getTime()||0));
    data.long_movements=data.movements.filter(m=>Number(m.duration_minutes)>1440).length;
    const missingEnd=data.movements.filter(m=>m.start&&!m.end).length;
    if(missingEnd)data.quality.push(`${missingEnd} movement(s) missing end time`);
    if(data.archive_records.length>1)data.quality.push(`${data.archive_records.length} archive records retained`);
    if(data.cy_records.length>1)data.quality.push(`${data.cy_records.length} CY Management records retained`);
    if(data.will_back_records.length>1)data.quality.push(`${data.will_back_records.length} return records retained`);
    if(!/^[A-Z]{4}\d{7}$/.test(key))data.quality.push('Non-standard or internal container identifier');
  }
  KEYS=Object.keys(DATA).sort();
  SEARCH_INDEX=KEYS.map(buildSearchIndexRecord);
  const pivot=counts.pivotStats||{final:0,half:0,local:0,total:0};
  BUILD_INFO={
    generated_at:new Date().toISOString(),source_files:sourceNames,cy_report_date:counts.reportDate||new Date().toISOString().slice(0,10),
    movements:counts.movementRows||0,archive:counts.archiveRows||0,customers:counts.customerRows||0,will_back:counts.returnRows||0,cy_records:counts.cyRows||0,containers:KEYS.length,
    pivot_final_seal:pivot.final||0,pivot_half_seal:pivot.half||0,pivot_local:pivot.local||0,pivot_total:pivot.total||0,detention_formula:'calendar_days_non_negative',
    source_diagnostics:counts.diagnostics||{},cached_pivot_stats:counts.cachedPivotStats||null
  };
}

function setSourceStatus(message,type=''){
  if(!sourceStatus)return;sourceStatus.textContent=message;sourceStatus.className='source-status'+(type?' '+type:'');
}
function updateSourceSelection(type,file){
  selectedSourceFiles[type]=file||null;
  const isMovement=type==='movement',card=isMovement?movementFileCard:managementFileCard,name=isMovement?movementFileName:managementFileName;
  card.classList.remove('error');card.classList.toggle('ready',!!file);
  name.textContent=file?`${file.name} — ${(file.size/1024/1024).toFixed(1)} MB`:(isMovement?'Click to choose the movement workbook':'Click to choose the CY workbook');
  loadSourcesBtn.disabled=!(selectedSourceFiles.movement&&selectedSourceFiles.management);
  if(selectedSourceFiles.movement&&selectedSourceFiles.management)setSourceStatus('Both files are selected. Click Load Data & Open System.','success');
  else setSourceStatus('Select both Excel files to continue.');
}
function resetSourceSelection(){
  selectedSourceFiles={movement:null,management:null};
  if(movementFileInput)movementFileInput.value='';if(managementFileInput)managementFileInput.value='';
  updateSourceSelection('movement',null);updateSourceSelection('management',null);
}
function openSourceScreen(){
  document.body.classList.add('sources-locked');
  backToSystemBtn.style.display=systemDataLoaded?'inline-flex':'none';
  setSourceStatus(selectedSourceFiles.movement&&selectedSourceFiles.management?'Both files are selected. Load them to refresh the system.':'Select both Excel files to continue.',selectedSourceFiles.movement&&selectedSourceFiles.management?'success':'');
}
function closeSourceScreen(){if(systemDataLoaded)document.body.classList.remove('sources-locked')}
function resetRuntimeData(){
  DATA={};KEYS=[];SEARCH_INDEX=[];systemDataLoaded=false;currentContainer=null;currentBatchContainers=[];deadlineAlertContainers=[];SYSTEM_SNAPSHOT_MS=null;
  BUILD_INFO={generated_at:null,source_files:[],cy_report_date:null,movements:0,archive:0,customers:0,will_back:0,cy_records:0,containers:0,pivot_final_seal:0,pivot_half_seal:0,pivot_local:0,pivot_total:0,detention_formula:'calendar_days_non_negative',system_opened_at:null};
  if(resultDiv){resultDiv.innerHTML='';resultDiv.style.display='none'}if(notFound)notFound.style.display='none';if(emptyState)emptyState.style.display='block';if(deadlineAlerts)deadlineAlerts.innerHTML='';
  const statEmptyEl=document.getElementById('statEmpty');if(statEmptyEl)statEmptyEl.textContent='0';
}
function initializeLoadedSystem(){
  const openedAt=new Date();
  SYSTEM_SNAPSHOT_MS=Date.UTC(openedAt.getFullYear(),openedAt.getMonth(),openedAt.getDate());
  BUILD_INFO.system_opened_at=openedAt.toISOString();
  document.getElementById('statFinalSeal').textContent=Number(BUILD_INFO.pivot_final_seal||0).toLocaleString('en-US');
  document.getElementById('statHalfSeal').textContent=Number(BUILD_INFO.pivot_half_seal||0).toLocaleString('en-US');
  document.getElementById('statLocal').textContent=Number(BUILD_INFO.pivot_local||0).toLocaleString('en-US');
  document.getElementById('statPivotTotal').textContent=Number(BUILD_INFO.pivot_total||0).toLocaleString('en-US');
  document.getElementById('statEmpty').textContent=countEmptyContainers().toLocaleString('en-US');
  mergeYardOnlyContainers();
  applyStatusOverrides();
  document.getElementById('updatedAt').textContent='Loaded: '+new Date(BUILD_INFO.generated_at).toLocaleString('en-GB')+' · Detention calculated as of '+fmtDatePlain(openedAt);
  clearSearch();updateBatchCounter();renderDeadlineAlerts();
  emptyState.innerHTML='<div class="empty-icon">📦</div><h2>Search for a Container</h2><p>The two Excel workbooks are loaded and linked in memory.<br>Search by container, seal, customer, carrier, BC or LSP.</p>';
  systemDataLoaded=true;backToSystemBtn.style.display='inline-flex';document.body.classList.remove('sources-locked');
  const query=new URLSearchParams(location.search).get('cntr');if(query)resolveSearch(query);else setTimeout(()=>input?.focus(),80);
}
async function loadSelectedSources(){
  if(!selectedSourceFiles.movement||!selectedSourceFiles.management)return;
  const previous={DATA,KEYS,SEARCH_INDEX,BUILD_INFO,systemDataLoaded};
  loadSourcesBtn.disabled=true;sourceProgress.classList.add('active');
  movementFileCard.classList.remove('error');managementFileCard.classList.remove('error');
  try{
    setSourceStatus('Reading CNTRs Movement Report…');await new Promise(resolve=>setTimeout(resolve,30));
    const movementBuffer=await selectedSourceFiles.movement.arrayBuffer();
    DATA={};KEYS=[];SEARCH_INDEX=[];
    const counts=await ingestMovementWorkbook(movementBuffer);
    setSourceStatus(`Movement workbook accepted — ${counts.movementRows.toLocaleString()} movement records. Reading CY Management Report…`);
    await new Promise(resolve=>setTimeout(resolve,30));
    const managementBuffer=await selectedSourceFiles.management.arrayBuffer();
    const managementCounts=await ingestManagementWorkbook(managementBuffer);
    counts.cyRows=managementCounts.cyRows;counts.reportDate=managementCounts.reportDate;
    counts.diagnostics={...(counts.diagnostics||{}),...(managementCounts.diagnostics||{})};
    setSourceStatus('Linking records, validating columns, calculating detention and preparing alerts…');await new Promise(resolve=>setTimeout(resolve,30));
    finalizeDynamicData(counts,[selectedSourceFiles.movement.name,selectedSourceFiles.management.name]);
    initializeLoadedSystem();
    setSourceStatus(`Loaded ${BUILD_INFO.movements.toLocaleString()} movements, ${BUILD_INFO.archive.toLocaleString()} archive rows, ${BUILD_INFO.cy_records.toLocaleString()} CY rows — syncing to the cloud, please keep this tab open…`);
    dlog('loadSelectedSources: about to call persistSystemData()');
    await persistSystemData();
    dlog('loadSelectedSources: persistSystemData() returned, continuing');
    setSourceStatus(`Data loaded successfully — ${BUILD_INFO.movements.toLocaleString()} movements, ${BUILD_INFO.archive.toLocaleString()} archive rows, ${BUILD_INFO.cy_records.toLocaleString()} CY rows.`, 'success');
    showToast(`✅ Loaded ${BUILD_INFO.containers.toLocaleString()} containers — Excel columns validated by header name`);
  }catch(error){
    dlog(`loadSelectedSources: ❌ caught error — ${error?.message||error}`);
    console.error(error);
    if(previous.systemDataLoaded){
      DATA=previous.DATA;KEYS=previous.KEYS;SEARCH_INDEX=previous.SEARCH_INDEX;BUILD_INFO=previous.BUILD_INFO;systemDataLoaded=true;
      backToSystemBtn.style.display='inline-flex';
    }else resetRuntimeData();
    document.body.classList.add('sources-locked');
    const message=error?.message||String(error);setSourceStatus(message,'error');
    if(/CNTR|Movement|Raw Data|Archive/i.test(message))movementFileCard.classList.add('error');
    if(/CY Management/i.test(message))managementFileCard.classList.add('error');
  }finally{
    sourceProgress.classList.remove('active');loadSourcesBtn.disabled=!(selectedSourceFiles.movement&&selectedSourceFiles.management);
  }
}

function clearVisibleData(){
  currentContainer=null;currentBatchContainers=[];deadlineAlertContainers=[];
  if(resultDiv){resultDiv.innerHTML='';resultDiv.style.display='none'}if(notFound)notFound.style.display='none';if(emptyState)emptyState.style.display='block';if(batchInput)batchInput.value='';if(input)input.value='';if(deadlineAlerts)deadlineAlerts.innerHTML='';
}
/* ── Idle auto-lock — 30 minutes of no interaction returns to the login screen.
   Matters more here than in most apps: this runs on shared handheld devices that
   can easily get left unlocked on a desk. */
const IDLE_LOCK_MS=30*60000;
let idleLockTimer=null;
function resetIdleLockTimer(){
  clearTimeout(idleLockTimer);
  if(document.body.classList.contains('auth-locked'))return;
  idleLockTimer=setTimeout(()=>{
    if(!document.body.classList.contains('auth-locked')){
      lockSystem();
      const err=document.getElementById('authError');if(err)err.textContent='You were signed out after 30 minutes of inactivity.';
    }
  },IDLE_LOCK_MS);
}
['click','keydown','touchstart','scroll'].forEach(ev=>document.addEventListener(ev,resetIdleLockTimer,{passive:true}));
resetIdleLockTimer();
function lockSystem(){
  storageRemove(AUTH_SESSION_KEY);resetRuntimeData();resetSourceSelection();clearVisibleData();
  idbDelete(IDB_DATA_KEY);
  if(FIREBASE_ENABLED&&fbReady){
    firebase.auth().signOut().then(()=>firebase.auth().signInAnonymously()).catch(err=>console.error('Could not reset the cloud session on logout',err));
  }
  renderHeaderUser();
  document.getElementById('cloudUpdateBar')?.classList.remove('show');
  document.body.classList.add('auth-locked','sources-locked');
  const form=document.getElementById('authForm');if(form)form.reset();
  const password=document.getElementById('authPassword');if(password)password.type='password';
  const toggle=document.getElementById('authPasswordToggle');if(toggle){toggle.textContent='👁';toggle.setAttribute('aria-label','Show password');toggle.title='Show password'}
  const error=document.getElementById('authError');if(error)error.textContent='';
  closeUsersModal();closeCalendarModal();
  refreshAuthScreenMode();
  setTimeout(()=>document.getElementById('authUsername')?.focus(),80);
}
function unlockToSourceScreen(){
  document.body.classList.remove('auth-locked');document.body.classList.add('sources-locked');
  const error=document.getElementById('authError');if(error)error.textContent='';
  backToSystemBtn.style.display='none';setTimeout(()=>movementFileInput?.focus(),80);
}
function refreshAuthScreenMode(){
  const hasUsers=Object.keys(loadUsers()).length>0;
  const note=document.getElementById('authNote');
  if(note)note.textContent=hasUsers
    ?'Your session remains active in this tab until you log out or close it.'
    :'No accounts exist yet. Use "I\'m the Controller" below to create the controller account, then add sign-in accounts from Manage Users.';
}
async function setupAuthentication(){
  const form=document.getElementById('authForm'),username=document.getElementById('authUsername'),password=document.getElementById('authPassword'),submit=document.getElementById('authSubmit'),error=document.getElementById('authError'),toggle=document.getElementById('authPasswordToggle'),logout=document.getElementById('logoutBtn'),note=document.getElementById('authNote');
  toggle?.addEventListener('click',()=>{const showing=password.type==='text';password.type=showing?'password':'text';toggle.textContent=showing?'👁':'🙈';toggle.setAttribute('aria-label',showing?'Show password':'Hide password');toggle.title=showing?'Show password':'Hide password';password.focus()});
  form?.addEventListener('submit',async event=>{
    event.preventDefault();error.textContent='';submit.disabled=true;submit.textContent='Checking login…';
    try{
      ensureCrypto();
      if(!Object.keys(loadUsers()).length)throw new Error('No sign-in accounts exist yet. Use "I\'m the Controller" below to create one.');
      const ok=await verifyUser(username.value,password.value);
      if(!ok)throw new Error('Incorrect username or password.');
      const userRec=loadUsers()[userKey(username.value)];
      const realEmail=realAuthEmailFor(username.value,userRec?.email);
      if(realEmail)await ensureRealAuthSession(realEmail,password.value);
      storageSet(AUTH_SESSION_KEY,userKey(username.value));
      password.value='';
      renderHeaderUser();touchPresence();
      showSkeletonOverlay();
      const restored=await tryRestorePersistedData();
      hideSkeletonOverlay();
      if(!restored)unlockToSourceScreen();
    }catch(err){error.textContent=err?.message||'Incorrect username or password.';password.select()}
    finally{submit.disabled=false;submit.textContent='Sign In';refreshAuthScreenMode()}
  });
  document.getElementById('authManageUsersLink')?.addEventListener('click',event=>{event.preventDefault();openUsersModal()});
  logout?.addEventListener('click',lockSystem);sourceLogoutBtn?.addEventListener('click',lockSystem);
  document.getElementById('cloudUpdateRefreshBtn')?.addEventListener('click',async()=>{
    const bar=document.getElementById('cloudUpdateBar');
    try{
      const payload=await pullLatestSystemData();
      if(payload){
        DATA=payload.DATA;KEYS=payload.KEYS&&payload.KEYS.length?payload.KEYS:Object.keys(DATA).sort();BUILD_INFO=payload.BUILD_INFO||BUILD_INFO;
        SEARCH_INDEX=KEYS.map(buildSearchIndexRecord);
        initializeLoadedSystem();
        if(bar)bar.classList.remove('show');
        showToast('☁️ Updated with the latest data');
      }
    }catch(err){console.error(err);showToast('⚠️ Could not refresh — check your internet connection')}
  });
  document.getElementById('cloudUpdateDismissBtn')?.addEventListener('click',()=>{const bar=document.getElementById('cloudUpdateBar');if(bar)bar.classList.remove('show')});
  if(note&&FIREBASE_ENABLED)note.textContent='Connecting to the cloud…';
  await initFirebase();
  await waitForFirebaseReady();
  listenAnnouncement(); // safe pre-login too — announcements only need any signed-in session
  const session=storageGet(AUTH_SESSION_KEY);
  const fbUser=FIREBASE_ENABLED&&fbReady?firebase.auth().currentUser:null;
  const hasRealSession=fbUser&&!fbUser.isAnonymous;
  if(session&&loadUsers()[session]&&(!FIREBASE_ENABLED||!fbReady||hasRealSession)){
    renderHeaderUser();touchPresence();
    showSkeletonOverlay();
    const restored=await tryRestorePersistedData();
    hideSkeletonOverlay();
    if(!restored)unlockToSourceScreen();
  }else{
    if(session&&FIREBASE_ENABLED&&fbReady&&!hasRealSession){
      // A username was remembered on this device, but the real cloud session behind
      // it was never established (or was lost) — can't silently continue without the
      // password, so fall back to asking for it again instead of a confusing failure.
      dlog?.('Persisted session found but the cloud session is still anonymous — asking to sign in again.');
    }
    refreshAuthScreenMode();setTimeout(()=>username?.focus(),80);
  }
}

/* ── Manage Users panel — gated by the controller account ── */
function openUsersModal(){
  document.getElementById('usersOverlay').classList.add('open');
  if(currentUserCan('canViewUsers')){
    document.getElementById('usersManageView').style.display='none';
    document.getElementById('usersGateView').style.display='none';
    document.getElementById('usersReadOnlyView').style.display='block';
    renderReadOnlyUsersList();
  }else{
    document.getElementById('usersReadOnlyView').style.display='none';
    showUsersGate();
    const backLink=document.getElementById('usersGateBackToViewLink');
    if(backLink)backLink.style.display='none';
  }
}
function renderReadOnlyUsersList(){
  const list=document.getElementById('usersReadOnlyList');if(!list)return;
  const users=loadUsers(),keys=Object.keys(users).sort();
  if(!keys.length){list.innerHTML='<div class="users-empty">No accounts yet.</div>';return}
  list.innerHTML=keys.map(key=>{
    const u=users[key];
    const badges=[
      u.isOperation?'<span class="op-badge">🏗️ Yard</span>':'',
      u.canExport?'<span class="op-badge" style="background:#E2F4F5;color:#0E7C86">📊 Export</span>':'',
      u.canUploadData?'<span class="op-badge" style="background:#E6F4EC;color:#1D6F42">📁 Upload</span>':'',
      u.canViewUsers?'<span class="op-badge" style="background:#EAF2FF;color:#1B4F8A">👥 View Users</span>':''
    ].filter(Boolean).join(' ');
    const contactBits=[u.email,u.phone].filter(Boolean).map(esc).join(' · ');
    return `<div class="users-row"><div><div class="uname">${esc(u.username)}</div><div class="umeta" style="margin:4px 0">${badges||'<span style="color:var(--muted)">No extra permissions</span>'}</div>${contactBits?`<div class="umeta">${contactBits}</div>`:''}</div></div>`;
  }).join('');
}
function closeUsersModal(){document.getElementById('usersOverlay')?.classList.remove('open')}
function showUsersGate(){
  document.getElementById('usersManageView').style.display='none';
  document.getElementById('usersGateView').style.display='block';
  const admin=loadAdmin(),setup=!admin;
  document.getElementById('usersGateIntro').textContent=setup
    ?'No controller account exists yet. Create it now — from then on, only this account can manage other users.'
    :'Enter the controller password to manage other users.';
  document.getElementById('adminGateSubmit').textContent=setup?'Create Controller Account':'Unlock';
  document.getElementById('adminGateConfirmField').style.display=setup?'block':'none';
  document.getElementById('adminGateError').textContent='';
  const uField=document.getElementById('adminGateUsername');
  uField.value=setup?'':admin.username;
  uField.readOnly=!setup;
  document.getElementById('adminGatePassword').value='';
  document.getElementById('adminGateConfirmPassword').value='';
  const resetRow=document.getElementById('adminResetRow');
  if(resetRow)resetRow.style.display=setup?'none':'block';
  setTimeout(()=>document.getElementById(setup?'adminGateUsername':'adminGatePassword')?.focus(),80);
}
async function handleAdminGateSubmit(){
  const uInput=document.getElementById('adminGateUsername'),pInput=document.getElementById('adminGatePassword'),cInput=document.getElementById('adminGateConfirmPassword'),err=document.getElementById('adminGateError'),btn=document.getElementById('adminGateSubmit');
  err.textContent='';btn.disabled=true;
  try{
    ensureCrypto();
    const setup=!loadAdmin();
    if(setup){
      if(pInput.value!==cInput.value)throw new Error('Passwords do not match.');
      await createAdmin(uInput.value,pInput.value);
      await ensureRealAuthSession(CONTROLLER_AUTH_EMAIL,pInput.value).catch(()=>{});
      showToast('✅ Controller account created');
    }else{
      const ok=await verifyAdmin(uInput.value,pInput.value);
      if(!ok)throw new Error('Incorrect controller password.');
      await ensureRealAuthSession(CONTROLLER_AUTH_EMAIL,pInput.value).catch(()=>{});
    }
    document.getElementById('usersGateView').style.display='none';
    document.getElementById('usersManageView').style.display='block';
    renderUsersList();
    renderOnlineUsers();
    renderLastBackupNote();
    renderControllerUid();
  }catch(e){err.textContent=e?.message||'Something went wrong.'}
  finally{btn.disabled=false}
}
async function handleForgotAdmin(){
  const admin=loadAdmin();if(!admin)return;
  const warn=`You're about to reset the controller account ("${admin.username}").\n\nThis does not touch any of the regular sign-in accounts — only the controller login is reset. Once reset, whoever fills in the new controller form next becomes the controller.\n\nOnly do this if you're sure it's really you. Continue?`;
  if(!confirm(warn))return;
  localStorage.removeItem(ADMIN_STORAGE_KEY);
  showToast('Controller account reset — create a new one below');
  showUsersGate();
}
async function handleChangeAdmin(){
  const admin=loadAdmin();if(!admin)return;
  const current=prompt('Enter your current controller password to confirm:');
  if(current===null)return;
  const ok=await verifyAdmin(admin.username,current);
  if(!ok){alert('Incorrect current password.');return}
  const newUsername=(prompt('New controller username (leave as-is to keep the current one):',admin.username)||'').trim()||admin.username;
  const newPassword=prompt('New controller password (at least 8 characters, letters + numbers):');
  if(newPassword===null)return;
  try{await createAdmin(newUsername,newPassword);showToast('✅ Controller credentials updated')}
  catch(e){alert(e?.message||'Could not update the controller account.')}
}
function renderUsersList(){
  const list=document.getElementById('usersList');if(!list)return;
  const users=loadUsers(),keys=Object.keys(users).sort();
  if(!keys.length){list.innerHTML='<div class="users-empty">No accounts yet — add the first one above.</div>';return}
  const ready=keys.filter(k=>users[k].email).length;
  const summary=`<div class="users-migration-note">${ready===keys.length?'✅':'⚠️'} ${ready}/${keys.length} accounts have an email on file and are ready for the secure sign-in upgrade${ready<keys.length?' — accounts without one will need to add it before the stricter cloud rules can go live for everyone.':''}</div>`;
  list.innerHTML=summary+keys.map(key=>{
    const u=users[key],created=u.createdAt?new Date(u.createdAt).toLocaleDateString('en-GB'):'—',reset=u.updatedAt?` · password reset ${new Date(u.updatedAt).toLocaleDateString('en-GB')}`:'';
    const contactBits=[u.email,u.phone].filter(Boolean).map(esc).join(' · ');
    const contactLine=contactBits?`<div class="umeta">${contactBits}</div>`:'<div class="umeta" style="color:var(--red)">⚠️ No email on file</div>';
    const badges=[
      u.isOperation?'<span class="op-badge">🏗️ Yard</span>':'',
      u.canExport?'<span class="op-badge" style="background:#E2F4F5;color:#0E7C86">📊 Export</span>':'',
      u.canUploadData?'<span class="op-badge" style="background:#E6F4EC;color:#1D6F42">📁 Upload</span>':'',
      u.canViewUsers?'<span class="op-badge" style="background:#EAF2FF;color:#1B4F8A">👥 View Users</span>':''
    ].filter(Boolean).join(' ');
    const emailBtn=u.email?'':`<button class="users-mini-btn" data-add-email="${esc(key)}">Add Email</button>`;
    return `<div class="users-row"><div><div class="uname">${esc(u.username)}</div><div class="umeta" style="margin:4px 0">${badges||'<span style="color:var(--muted)">No extra permissions — search &amp; view only</span>'}</div>${contactLine}<div class="umeta">Created ${created}${reset}</div></div><div class="users-row-actions">${emailBtn}<button class="users-mini-btn" data-toggle-op="${esc(key)}">${u.isOperation?'−Yard':'+Yard'}</button><button class="users-mini-btn" data-toggle-perm="canExport" data-user-key="${esc(key)}">${u.canExport?'−Export':'+Export'}</button><button class="users-mini-btn" data-toggle-perm="canUploadData" data-user-key="${esc(key)}">${u.canUploadData?'−Upload':'+Upload'}</button><button class="users-mini-btn" data-toggle-perm="canViewUsers" data-user-key="${esc(key)}">${u.canViewUsers?'−ViewUsers':'+ViewUsers'}</button><button class="users-mini-btn" data-reset-user="${esc(key)}">Reset Password</button><button class="users-mini-btn danger" data-delete-user="${esc(key)}">Delete</button></div></div>`;
  }).join('');
}
async function handleAddUser(){
  const uInput=document.getElementById('newUserName'),eInput=document.getElementById('newUserEmail'),phInput=document.getElementById('newUserPhone'),pInput=document.getElementById('newUserPass'),opInput=document.getElementById('newUserIsOperation'),exportInput=document.getElementById('newUserCanExport'),uploadInput=document.getElementById('newUserCanUpload'),viewUsersInput=document.getElementById('newUserCanViewUsers'),err=document.getElementById('usersAddError');
  err.textContent='';
  try{
    ensureCrypto();
    if(!String(eInput.value||'').trim())throw new Error('Enter an email address for this account.');
    const createdName=uInput.value;
    await createUser(uInput.value,pInput.value,eInput.value,phInput.value,opInput.checked,{canExport:exportInput.checked,canUploadData:uploadInput.checked,canViewUsers:viewUsersInput.checked});
    uInput.value='';eInput.value='';phInput.value='';pInput.value='';opInput.checked=false;exportInput.checked=false;uploadInput.checked=false;viewUsersInput.checked=false;
    renderUsersList();showToast(`✅ Account "${createdName}" created`);
  }catch(e){err.textContent=e?.message||'Could not create the account.'}
}
async function handleUsersListClick(e){
  const resetKey=e.target?.dataset?.resetUser,delKey=e.target?.dataset?.deleteUser,opKey=e.target?.dataset?.toggleOp,emailKey=e.target?.dataset?.addEmail,permName=e.target?.dataset?.togglePerm,permKey=e.target?.dataset?.userKey;
  if(emailKey){
    const label=loadUsers()[emailKey]?.username||emailKey;
    const email=prompt(`Email address for "${label}" — needed so they can move to the more secure sign-in:`);
    if(email===null)return;
    try{await setUserEmail(emailKey,email);renderUsersList();showToast(`✅ Email saved for ${label} — they'll be upgraded automatically on next login`)}
    catch(err){alert(err?.message||'Could not save this email.')}
  }
  if(opKey){
    const user=loadUsers()[opKey];
    try{await setUserOperationFlag(opKey,!user?.isOperation);renderUsersList();showToast(user?.isOperation?'Removed Operation role':'✅ Granted Operation role')}
    catch(err){alert(err?.message||'Could not update this account.')}
  }
  if(permName&&permKey){
    const user=loadUsers()[permKey];
    const labels={canExport:'Export',canUploadData:'Upload',canViewUsers:'View Users'};
    try{await setUserPermFlag(permKey,permName,!user?.[permName]);renderUsersList();showToast(user?.[permName]?`Removed ${labels[permName]} permission`:`✅ Granted ${labels[permName]} permission`)}
    catch(err){alert(err?.message||'Could not update this account.')}
  }
  if(resetKey){
    const label=loadUsers()[resetKey]?.username||resetKey;
    const np=prompt(`New password for "${label}" (at least 8 characters, letters + numbers):`);
    if(np===null)return;
    try{
      const result=await resetUserPassword(resetKey,np);
      showToast(result.emailSent?`✅ Password updated for ${label} — a reset email was also sent to ${result.email} for their secure sign-in`:`✅ Password updated for ${label}`);
      renderUsersList();
    }catch(err){alert(err?.message||'Could not reset the password.')}
  }
  if(delKey){
    const label=loadUsers()[delKey]?.username||delKey;
    if(Object.keys(loadUsers()).length<=1){alert('At least one account must remain.');return}
    if(!confirm(`Delete the account "${label}"? This cannot be undone.`))return;
    try{
      await deleteUser(delKey);
      if(storageGet(AUTH_SESSION_KEY)===delKey)lockSystem();
      showToast(`Deleted account ${label}`);renderUsersList();
    }catch(err){alert(err?.message||'Could not delete this account.')}
  }
}

/* ── Calendar & week number ── */
function startOfWeekMonday(d){
  const date=new Date(d.getFullYear(),d.getMonth(),d.getDate());
  const day=date.getDay();
  date.setDate(date.getDate()+(day===0?-6:1-day));
  return date;
}
function getWeekInfo(date=new Date()){
  const year=date.getFullYear();
  const anchor=startOfWeekMonday(new Date(year,0,1));
  const weekStart=startOfWeekMonday(date);
  const weekNumber=Math.round((weekStart-anchor)/604800000)+1;
  const weekEnd=new Date(weekStart);weekEnd.setDate(weekEnd.getDate()+6);
  return{year,weekNumber,start:weekStart,end:weekEnd};
}
function buildYearWeeks(year){
  const dec31=new Date(year,11,31);
  let cursor=startOfWeekMonday(new Date(year,0,1));
  const weeks=[];let n=1;
  while(cursor<=dec31){
    const end=new Date(cursor);end.setDate(end.getDate()+6);
    weeks.push({weekNumber:n,start:new Date(cursor),end});
    cursor=new Date(cursor);cursor.setDate(cursor.getDate()+7);n++;
  }
  return weeks;
}
function fmtClockTime(d){return d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit'})}
function fmtClockDate(d){return d.toLocaleDateString('en-GB',{weekday:'short',day:'2-digit',month:'short',year:'numeric'})}
function tickClock(){
  const now=new Date(),t=document.getElementById('headerClockTime'),d=document.getElementById('headerClockDate'),w=document.getElementById('headerWeekNum');
  if(t)t.textContent=fmtClockTime(now);
  if(d)d.textContent=fmtClockDate(now);
  if(w)w.textContent='W'+getWeekInfo(now).weekNumber;
}

/* ── Holidays ── */
const HOLIDAYS_LOCAL_KEY='container_lookup_holidays_v1';
// Seed list — official Egypt public holidays for 2026. Islamic-calendar holidays (Eid al-Fitr,
// Eid al-Adha, Islamic New Year, Al-Mouled Al-Nabawy) shift every year — use "Manage holidays"
// below the calendar to add next year's dates once they're announced, or to fix any of these.
const DEFAULT_HOLIDAYS=[
  {date:'2026-01-01',name:"New Year's Day",nameAr:'رأس السنة الميلادية'},
  {date:'2026-01-07',name:'Coptic Christmas',nameAr:'عيد الميلاد المجيد'},
  {date:'2026-01-29',name:'Revolution Day (25 Jan, observed)',nameAr:'عيد الشرطة وثورة 25 يناير'},
  {date:'2026-03-19',name:'Eid Al-Fitr Holiday',nameAr:'إجازة عيد الفطر'},
  {date:'2026-03-20',name:'Eid Al-Fitr',nameAr:'عيد الفطر المبارك'},
  {date:'2026-03-21',name:'Eid Al-Fitr Holiday (Day 2)',nameAr:'إجازة عيد الفطر (اليوم الثاني)'},
  {date:'2026-03-22',name:'Eid Al-Fitr Holiday (Day 3)',nameAr:'إجازة عيد الفطر (اليوم الثالث)'},
  {date:'2026-03-23',name:'Eid Al-Fitr Holiday (Day 4)',nameAr:'إجازة عيد الفطر (اليوم الرابع)'},
  {date:'2026-04-12',name:'Coptic Easter Sunday',nameAr:'عيد القيامة المجيد'},
  {date:'2026-04-13',name:'Sham El Nessim',nameAr:'شم النسيم'},
  {date:'2026-04-25',name:'Sinai Liberation Day',nameAr:'عيد تحرير سيناء'},
  {date:'2026-05-07',name:'Labour Day (observed)',nameAr:'عيد العمال'},
  {date:'2026-05-26',name:'Arafat Day',nameAr:'يوم عرفة'},
  {date:'2026-05-27',name:'Eid Al-Adha',nameAr:'عيد الأضحى المبارك'},
  {date:'2026-05-28',name:'Eid Al-Adha Holiday',nameAr:'إجازة عيد الأضحى'},
  {date:'2026-05-29',name:'Eid Al-Adha Holiday',nameAr:'إجازة عيد الأضحى'},
  {date:'2026-05-30',name:'Eid Al-Adha Holiday',nameAr:'إجازة عيد الأضحى'},
  {date:'2026-05-31',name:'Eid Al-Adha Holiday',nameAr:'إجازة عيد الأضحى'},
  {date:'2026-06-18',name:'Islamic New Year',nameAr:'رأس السنة الهجرية'},
  {date:'2026-07-02',name:'June 30 Revolution Day (observed)',nameAr:'ثورة 30 يونيو'},
  {date:'2026-07-23',name:'July 23 Revolution Day',nameAr:'ثورة 23 يوليو'},
  {date:'2026-08-25',name:"Al-Mouled Al-Nabawy (Prophet's Birthday)",nameAr:'المولد النبوي الشريف'},
  {date:'2026-10-09',name:'Armed Forces Day',nameAr:'عيد القوات المسلحة'}
];
function loadHolidays(){
  try{
    const raw=localStorage.getItem(HOLIDAYS_LOCAL_KEY);
    if(raw===null){localStorage.setItem(HOLIDAYS_LOCAL_KEY,JSON.stringify(DEFAULT_HOLIDAYS));return DEFAULT_HOLIDAYS.slice()}
    const parsed=JSON.parse(raw);return Array.isArray(parsed)?parsed:[];
  }catch(_){return DEFAULT_HOLIDAYS.slice()}
}
function saveHolidays(list){try{localStorage.setItem(HOLIDAYS_LOCAL_KEY,JSON.stringify(list))}catch(_){}}
function holidayMap(){const m=new Map();for(const h of loadHolidays()){if(h?.date)m.set(h.date,h)}return m}
function holidayDisplayName(h){return loadLanguage()==='ar'&&h.nameAr?h.nameAr:(h.name||'Holiday')}
function isoDateKey(d){return`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`}

let calViewDate=new Date();
function renderCalendarModal(){
  const now=new Date(),info=getWeekInfo(now);
  document.getElementById('calCurrentWeek').textContent=`Week ${info.weekNumber}`;
  document.getElementById('calCurrentRange').textContent=`${fmtDatePlain(info.start)} – ${fmtDatePlain(info.end)} · ${info.year}`;
  document.getElementById('calCurrentDate').textContent=fmtClockDate(now);
  const y=calViewDate.getFullYear(),m=calViewDate.getMonth();
  const holidays=holidayMap();
  document.getElementById('calMonthLabel').textContent=calViewDate.toLocaleDateString('en-GB',{month:'long',year:'numeric'});
  const dows=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  let html=dows.map(x=>`<div class="dow">${x}</div>`).join('');
  let cursor=startOfWeekMonday(new Date(y,m,1));
  for(let i=0;i<42;i++){
    const inMonth=cursor.getMonth()===m,isToday=cursor.toDateString()===now.toDateString();
    const key=isoDateKey(cursor),holiday=holidays.get(key),holidayName=holiday?holidayDisplayName(holiday):'';
    html+=`<div class="day${inMonth?'':' other'}${isToday?' today':''}${holiday?' holiday':''}"${holiday?` title="${esc(holidayName)}" data-holiday-date="${esc(key)}"`:''}>${cursor.getDate()}</div>`;
    cursor=new Date(cursor);cursor.setDate(cursor.getDate()+1);
  }
  document.getElementById('calMonthGrid').innerHTML=html;
  document.getElementById('calMonthGrid').querySelectorAll('[data-holiday-date]').forEach(el=>{
    el.addEventListener('click',()=>{
      const h=holidays.get(el.dataset.holidayDate);if(!h)return;
      const locale=loadLanguage()==='ar'?'ar-EG':loadLanguage()==='ko'?'ko-KR':'en-GB';
      const label=new Date(el.dataset.holidayDate+'T00:00:00').toLocaleDateString(locale,{weekday:'long',day:'2-digit',month:'long',year:'numeric'});
      showToast(`🎉 ${label} — ${holidayDisplayName(h)}`);
    });
  });
  document.getElementById('calHolidaysTitle').textContent=`Holidays — ${y}`;
  const yearHolidays=loadHolidays().filter(h=>h?.date?.startsWith(String(y))).sort((a,b)=>a.date.localeCompare(b.date));
  const todayKey=isoDateKey(now);
  document.getElementById('calHolidaysList').innerHTML=yearHolidays.length?yearHolidays.map(h=>{
    const d=new Date(h.date+'T00:00:00'),label=d.toLocaleDateString('en-GB',{day:'2-digit',month:'short'}),dow=d.toLocaleDateString('en-GB',{weekday:'short'});
    const past=h.date<todayKey;
    return`<div class="cal-holiday-row${past?' cal-holiday-past':''}"><span class="chd-date">${esc(label)}<small>${esc(dow)}</small></span><span class="chd-name">${esc(holidayDisplayName(h))}</span></div>`;
  }).join(''):'<div class="cal-holiday-empty">No holidays on record for this year.</div>';
  document.getElementById('calWeeksTitle').textContent=`Weeks of ${y} — Monday to Monday`;
  const tbody=document.getElementById('calWeeksBody');
  tbody.innerHTML=buildYearWeeks(y).map(wk=>`<tr class="${wk.weekNumber===info.weekNumber&&y===info.year?'current-week':''}"><td>Week ${wk.weekNumber}</td><td>${fmtDatePlain(wk.start)}</td><td>${fmtDatePlain(wk.end)}</td></tr>`).join('');
  const current=tbody.querySelector('.current-week');if(current)setTimeout(()=>current.scrollIntoView({block:'center'}),0);
}
function calShiftMonth(delta){calViewDate=new Date(calViewDate.getFullYear(),calViewDate.getMonth()+delta,1);renderCalendarModal()}
function calGoToday(){calViewDate=new Date();renderCalendarModal()}
function openCalendarModal(){
  calViewDate=new Date();renderCalendarModal();
  document.getElementById('calOverlay').classList.add('open');
}
function closeCalendarModal(){document.getElementById('calOverlay')?.classList.remove('open')}

/* ── Yard Operations modal ── */
let yardSetupDraft=null;
function openYardModal(prefillContainer){
  document.getElementById('yardOverlay').classList.add('open');
  refreshYardModal();
  if(prefillContainer){
    switchYardTab('log');
    const input=document.getElementById('yardMoveContainer');
    if(input){input.value=prefillContainer;loadYardMoveHistoryFor(prefillContainer)}
  }
}
function closeYardModal(){document.getElementById('yardOverlay')?.classList.remove('open')}
function switchYardTab(tab){
  document.querySelectorAll('.yard-tab').forEach(btn=>btn.classList.toggle('active',btn.dataset.yardTab===tab));
  document.getElementById('yardMapPanel').style.display=tab==='map'?'block':'none';
  document.getElementById('yardLogPanel').style.display=tab==='log'?'block':'none';
  document.getElementById('yardSetupPanel').style.display=tab==='setup'?'block':'none';
  const backBtn=document.getElementById('yardTabBackBtn');if(backBtn)backBtn.style.display=tab==='map'?'none':'inline-block';
  if(tab==='log')prepareYardLogForm();
  if(tab==='setup'){yardSetupDraft=null;renderYardSetup()}
}
function refreshYardModal(){
  renderYardMap();
  const activeTab=document.querySelector('.yard-tab.active')?.dataset.yardTab||'map';
  if(activeTab==='log')prepareYardLogForm();
}
/* ── Yard inventory report (Excel + PDF) — every stack, its containers and locations ── */
function buildYardInventoryData(){
  const cfg=loadYardConfig(),locs=loadYardLocations();
  const stacks=(cfg?.stacks||[]).slice().sort((a,b)=>String(a.name).localeCompare(String(b.name)));
  const summary=[],detail=[];
  let totalOccupied=0,totalCapacity=0;
  for(const stack of stacks){
    const bays=(stack.bays||[]).slice().sort((a,b)=>a-b);
    const capacity=yardStackCapacity(stack);
    const stackLocs=Object.values(locs).filter(l=>l.stack===stack.name).sort((a,b)=>Number(a.bay)-Number(b.bay)||Number(a.row)-Number(b.row)||Number(a.tier)-Number(b.tier));
    summary.push([stack.name,bays.length,stack.rows,stack.tiers,capacity,stackLocs.length,capacity?Math.round(stackLocs.length/capacity*100)+'%':'0%']);
    totalOccupied+=stackLocs.length;totalCapacity+=capacity;
    for(const loc of stackLocs){
      detail.push([stack.name,yardBayLabel(loc.bay),loc.row,loc.tier,loc.container,String(loc.container||'').slice(0,4),loc.updatedBy||'',loc.updatedAt?new Date(loc.updatedAt).toLocaleString('en-GB'):'',loc.note||'']);
    }
  }
  summary.push(['TOTAL','','','',totalCapacity,totalOccupied,totalCapacity?Math.round(totalOccupied/totalCapacity*100)+'%':'0%']);
  return{summary,detail,generatedAt:new Date()};
}
/* ── Manual full backup — one JSON snapshot of everything stored in the cloud ── */
const LAST_BACKUP_KEY='container_lookup_last_backup_v1';
function renderControllerUid(){
  const el=document.getElementById('controllerUidText');if(!el)return;
  const uid=(FIREBASE_ENABLED&&fbReady&&firebase.auth().currentUser&&!firebase.auth().currentUser.isAnonymous)?firebase.auth().currentUser.uid:null;
  el.textContent=uid?`Your ID: ${uid}`:'Not signed in with a real account yet — enable Email/Password sign-in and log in again first';
  el.dataset.uid=uid||'';
}
function renderLastBackupNote(){
  const el=document.getElementById('lastBackupNote');if(!el)return;
  let last=null;try{last=localStorage.getItem(LAST_BACKUP_KEY)}catch(_){}
  const daysSince=last?Math.floor((Date.now()-new Date(last).getTime())/86400000):null;
  const stale=daysSince===null||daysSince>7;
  el.textContent=last?`Last backup from this device: ${new Date(last).toLocaleString('en-GB')}${stale?` — ⚠️ ${daysSince} day${daysSince===1?'':'s'} ago, consider backing up again`:''}`:'⚠️ No backup downloaded yet on this device — take one now';
  el.style.color=stale?'#F5B15C':'';
  el.style.fontWeight=stale?'700':'';
}
async function downloadFullBackup(){
  if(!FIREBASE_ENABLED||!fbReady){alert('Cloud sync is not connected on this device — there is nothing in the cloud to back up from here.');return}
  showToast('⏳ Building backup — this can take a moment…');
  try{
    const backup={exportedAt:new Date().toISOString(),exportedBy:storageGet(AUTH_SESSION_KEY)||'unknown'};
    backup.systemData={DATA,KEYS,BUILD_INFO};
    backup.users=loadUsers();
    const yardConfigSnap=await fbDb.collection('yardConfig').doc('layout').get();
    backup.yardConfig=yardConfigSnap.exists?yardConfigSnap.data():null;
    const yardLocsSnap=await fbDb.collection('yardLocations').get();
    backup.yardLocations={};yardLocsSnap.forEach(d=>{backup.yardLocations[d.id]=d.data()});
    const yardMovesSnap=await fbDb.collection('yardMoves').get();
    backup.yardMoves=[];yardMovesSnap.forEach(d=>backup.yardMoves.push({id:d.id,...d.data()}));
    const json=JSON.stringify(backup,(k,v)=>v&&v.toDate?v.toDate().toISOString():v,2);
    const blob=new Blob([json],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');
    a.href=url;a.download=`CONTAINER_SYSTEM_BACKUP_${new Date().toISOString().slice(0,10)}.json`;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
    try{localStorage.setItem(LAST_BACKUP_KEY,new Date().toISOString())}catch(_){}
    renderLastBackupNote();
    renderControllerUid();
    showToast('✅ Backup downloaded — keep it somewhere safe (Drive, email to yourself, etc.)');
  }catch(err){
    console.error('Backup failed',err);
    alert('Backup failed: '+(err?.message||err));
  }
}
function downloadYardReportExcel(){
  if(!requireExportPermission())return;
  try{
    const{summary,detail,generatedAt}=buildYardInventoryData();
    const xml=`<?xml version="1.0"?><?mso-application progid="Excel.Sheet"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Styles><Style ss:ID="Header"><Font ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#1B4F8A" ss:Pattern="Solid"/></Style></Styles>${ssSheet('Stack Summary',['Stack','Bays','Rows','Tiers','Capacity','Occupied','Occupancy'],summary)}${ssSheet('Container Locations',['Stack','Bay','Row','Tier','Container','Owner Prefix','Logged By','Last Updated','Note'],detail)}</Workbook>`;
    const blob=new Blob([xml],{type:'application/vnd.ms-excel'}),url=URL.createObjectURL(blob),a=document.createElement('a');
    a.href=url;a.download=`YARD_INVENTORY_${generatedAt.toISOString().slice(0,10)}.xls`;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
    showToast('✅ Yard inventory Excel downloaded');
  }catch(e){alert('Yard report export failed: '+e.message)}
}
function downloadYardReportPDF(){
  if(!requireExportPermission())return;
  try{
    const{summary,detail,generatedAt}=buildYardInventoryData();
    const summaryRows=summary.map(r=>`<tr><td>${xmlEscape(r[0])}</td><td>${xmlEscape(r[1])}</td><td>${xmlEscape(r[2])}</td><td>${xmlEscape(r[3])}</td><td>${xmlEscape(r[4])}</td><td>${xmlEscape(r[5])}</td><td>${xmlEscape(r[6])}</td></tr>`).join('');
    const detailRows=detail.map(r=>`<tr><td>${xmlEscape(r[0])}${xmlEscape(r[1])}</td><td>${xmlEscape(r[2])}</td><td>${xmlEscape(r[3])}</td><td class="mono">${xmlEscape(r[4])}</td><td><span class="swatch" style="background:${yardCarrierColor(r[4])}"></span>${xmlEscape(r[5])}</td><td>${xmlEscape(r[6])}</td><td>${xmlEscape(r[7])}</td></tr>`).join('');
    const doc=`<!doctype html><html><head><meta charset="utf-8"><title>Yard Inventory Report</title><style>@page{size:A4 landscape;margin:12mm}*{box-sizing:border-box}body{font-family:Arial;color:#1A2332;font-size:10px;margin:0}header{background:#0D1B2A;color:#fff;padding:14px;border-bottom:3px solid #F4A41B;margin-bottom:12px}header h1{margin:0;font-size:18px}header div{margin-top:4px;color:#A8C4E0}h3{background:#0D1B2A;color:#fff;padding:6px 8px;margin:16px 0 0;font-size:11px}table{width:100%;border-collapse:collapse;margin-top:6px}td,th{border:1px solid #D8E1EC;padding:4px 6px}th{background:#1B4F8A;color:#fff}.mono{font-family:'Courier New',monospace}.swatch{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:5px;vertical-align:middle}</style></head><body><header><h1>YARD INVENTORY REPORT</h1><div>Generated ${generatedAt.toLocaleString('en-GB')} · ${detail.length} container(s) currently on the yard</div></header><h3>STACK SUMMARY</h3><table><thead><tr><th>Stack</th><th>Bays</th><th>Rows</th><th>Tiers</th><th>Capacity</th><th>Occupied</th><th>Occupancy</th></tr></thead><tbody>${summaryRows}</tbody></table><h3>CONTAINER LOCATIONS</h3><table><thead><tr><th>Stack.Bay</th><th>Row</th><th>Tier</th><th>Container</th><th>Owner Prefix</th><th>Logged By</th><th>Last Updated</th></tr></thead><tbody>${detailRows||'<tr><td colspan="7">No containers currently logged in the yard</td></tr>'}</tbody></table><script>window.onload=()=>window.print();<\\/script></body></html>`;
    const win=window.open('','_blank');if(!win)return alert('Please allow pop-ups to print the report.');
    win.document.write(doc);win.document.close();
  }catch(e){alert('Yard report export failed: '+e.message)}
}
function renderYardMap(){
  const cfg=loadYardConfig(),locs=loadYardLocations();
  const summary=document.getElementById('yardSummary'),grids=document.getElementById('yardMapGrids');
  if(!summary||!grids)return;
  const stacks=cfg?.stacks||[];
  if(!stacks.length){
    summary.innerHTML='';
    grids.innerHTML='<div class="yard-empty-note">No yard layout defined yet. Open the ⚙️ Setup tab to add stacks (or load the Stack A/B/G/D preset).</div>';
    return;
  }
  let totalSlots=0,occupiedSlots=0,totalBays=0;
  stacks.forEach(st=>{totalBays+=(st.bays?.length||0);totalSlots+=yardStackCapacity(st)});
  Object.values(locs).forEach(loc=>{
    const stack=stacks.find(st=>st.name===loc.stack);
    if(stack&&(stack.bays||[]).includes(Number(loc.bay))&&Number(loc.row)<=stack.rows&&Number(loc.tier)<=stack.tiers&&!yardLocationDisabled(stack,loc.bay,loc.row,loc.tier))occupiedSlots++;
  });
  const occPct=totalSlots?Math.round(occupiedSlots/totalSlots*100):0;
  summary.innerHTML=`<div class="yard-summary-item"><strong>${totalBays}</strong><span>Total Bays</span></div><div class="yard-summary-item"><strong>${totalSlots}</strong><span>Total Capacity</span></div><div class="yard-summary-item"><strong>${Object.keys(locs).length}</strong><span>Containers Tracked</span></div><div class="yard-summary-item"><strong>${totalSlots-occupiedSlots}</strong><span>Empty Slots</span></div><div class="yard-summary-item"><strong>${occPct}%</strong><span>Yard Occupancy</span></div>`;
  grids.innerHTML=`<div class="yard-legend"><span><i class="lg-empty"></i>Empty</span><span><i class="lg-partial"></i>Partial</span><span><i class="lg-full"></i>Full</span><span><i class="lg-locked"></i>Locked / Reserved</span></div>`+
  stacks.map(stack=>{
    const bays=stack.bays||[],locked=stack.lockedBays||[];
    let stackOccupied=0,stackCapacity=0;
    const tiles=bays.map(bay=>{
      const capacity=yardBayCapacity(stack,bay);
      stackCapacity+=capacity;
      const count=Object.values(locs).filter(l=>l.stack===stack.name&&Number(l.bay)===bay).length;
      stackOccupied+=count;
      const isLocked=locked.includes(bay);
      const status=isLocked?'locked':count===0?'empty':count>=capacity?'full':'partial';
      return `<div class="yard-bay-tile status-${status}" data-yard-bay="${esc(stack.name)}|${bay}" title="${esc(stack.name)}${yardBayLabel(bay)} — ${count}/${capacity}${isLocked?' (locked)':''}"><span class="ybt-name">${esc(stack.name)}${yardBayLabel(bay)}</span><span class="ybt-frac">${count}/${capacity}</span></div>`;
    }).join('');
    return `<div class="yard-stack-card"><div class="yard-stack-head"><span class="ysh-icon">🏗️</span><div><h3>Stack ${esc(stack.name)}</h3><div class="ysh-meta">${bays.length} bays · ${stack.rows} rows × ${stack.tiers} tiers</div></div><div class="ysh-occ"><strong>${stackOccupied}/${stackCapacity}</strong><span>Occupied</span></div></div><div class="yard-bay-tiles">${tiles||'<div class="yard-empty-note">No bays defined</div>'}</div></div>`;
  }).join('');
  grids.querySelectorAll('[data-yard-bay]').forEach(tile=>{
    tile.addEventListener('click',()=>{
      const[stackName,bay]=tile.dataset.yardBay.split('|');
      openYardBayModal(stackName,Number(bay));
    });
  });
}
function openYardBayModal(stackName,bay,highlightRow,highlightTier){
  const cfg=loadYardConfig(),stack=(cfg?.stacks||[]).find(st=>st.name===stackName);
  if(!stack)return;
  const locs=loadYardLocations();
  const isLocked=(stack.lockedBays||[]).includes(bay);
  const inBay=Object.values(locs).filter(l=>l.stack===stackName&&Number(l.bay)===bay);
  const capacity=yardBayCapacity(stack,bay),occupied=inBay.length,empty=capacity-occupied,pct=capacity?Math.round(occupied/capacity*100):0;
  document.getElementById('yardBayTitle').textContent=`📍 Stack ${stackName} · Bay ${yardBayLabel(bay)}${isLocked?' 🔒':''}`;
  document.getElementById('yardBaySubtitle').textContent=`${stack.rows} rows × ${stack.tiers} tiers${isLocked?' — Locked / Reserved':''}`;
  const occupancy={};inBay.forEach(loc=>{occupancy[`${loc.row}/${loc.tier}`]=loc});
  let rowsHtml='';
  for(let t=stack.tiers;t>=1;t--){
    let rowCells='';
    for(let r=stack.rows;r>=1;r--){
      if(yardLocationDisabled(stack,bay,r,t)){rowCells+=`<div class="yard-bay-slot blocked" title="${esc(yardLocationCode(stackName,bay,r,t))} — Disabled">Disabled</div>`;continue}
      const match=occupancy[`${r}/${t}`];
      const isHi=highlightRow!=null&&Number(highlightRow)===r&&Number(highlightTier)===t;
      const tip=match?yardSlotTooltip(match):`${esc(yardLocationCode(stackName,bay,r,t))} — empty`;
      rowCells+=`<div class="yard-bay-slot${match?' occupied':''}${isHi?' highlight':''}" data-yard-slot="${r}|${t}" tabindex="0" role="button" aria-label="${esc(yardLocationCode(stackName,bay,r,t))}${match?', occupied by '+esc(match.container):', empty'}"${match?` style="background:${yardCarrierColor(match.container)};color:${yardCarrierTextColor(yardCarrierColor(match.container))}"`:''} title="${tip}"><span class="ys-tier">R${r}</span>${match?`<span class="ys-carrier">${esc(String(match.container).slice(0,4))}</span><span class="ys-num">${esc(String(match.container).slice(4))}</span>`:'—'}</div>`;
    }
    rowsHtml+=`<div class="yard-bay-grid-row" style="grid-template-columns:56px repeat(${stack.rows},1fr)"><span class="yard-tier-band-label">T${t}</span>${rowCells}</div>`;
  }
  rowsHtml+=`<div class="yard-bay-grid-row yard-bay-grid-axis" style="grid-template-columns:56px repeat(${stack.rows},1fr)"><span></span>${Array.from({length:stack.rows},(_,i)=>stack.rows-i).map(r=>`<span>R${r}</span>`).join('')}</div>`;
  const listHtml=inBay.length?`<div class="yard-bay-list">${inBay.map(loc=>`<div class="yard-bay-list-item" data-yard-list-container="${esc(loc.container)}"><span>${esc(loc.container)}</span><span class="ybl-loc">${esc(yardLocationCode(stackName,bay,loc.row,loc.tier))}</span></div>`).join('')}</div>`:'<div class="yard-empty-note">No containers currently in this bay.</div>';
  document.getElementById('yardBayBody').innerHTML=`
    <div class="yard-bay-stats">
      <div class="ybs-item"><strong>${capacity}</strong><span>Total Slots</span></div>
      <div class="ybs-item"><strong>${occupied}</strong><span>Occupied</span></div>
      <div class="ybs-item"><strong>${empty}</strong><span>Empty</span></div>
      <div class="ybs-item"><strong>${pct}%</strong><span>Occupancy</span></div>
    </div>
    <div class="yard-bay-grid">${rowsHtml}</div>
    <div class="cal-holiday-empty" style="margin:-10px 0 14px">🎨 Box color reflects the container's carrier/owner prefix.</div>
    <div class="cal-section-title">Containers in this bay</div>
    ${listHtml}
  `;
  document.getElementById('yardBayBody').querySelectorAll('[data-yard-slot]').forEach(cell=>{
    let pressTimer=null,longPressed=false;
    const startPress=()=>{
      longPressed=false;
      pressTimer=setTimeout(()=>{
        longPressed=true;
        const[row,tier]=cell.dataset.yardSlot.split('|');
        const match=occupancy[`${row}/${tier}`];
        if(match&&currentUserIsOperation())handleLongPressRemove(match);
      },600);
    };
    const cancelPress=()=>{clearTimeout(pressTimer)};
    cell.addEventListener('pointerdown',startPress);
    cell.addEventListener('pointerup',cancelPress);
    cell.addEventListener('pointerleave',cancelPress);
    cell.addEventListener('pointercancel',cancelPress);
    cell.addEventListener('contextmenu',e=>e.preventDefault());
    cell.addEventListener('selectstart',e=>e.preventDefault());
    cell.addEventListener('click',()=>{
      if(longPressed){longPressed=false;return}
      const[row,tier]=cell.dataset.yardSlot.split('|');
      applyColumnHighlight(row,tier);
      const match=occupancy[`${row}/${tier}`];
      if(match)return openYardDetailPanel(match);
      if(currentUserIsOperation()){
        closeYardBayModal();
        switchYardTab('log');
        document.getElementById('yardMoveStack').value=stackName;updateYardBaySelect();
        document.getElementById('yardMoveBay').value=bay;updateYardRowTierSelects();
        document.getElementById('yardMoveRow').value=row;document.getElementById('yardMoveTier').value=tier;
        updateYardLocationPreview();
      }
    });
    cell.addEventListener('keydown',e=>{
      if(e.key==='Enter'||e.key===' '){e.preventDefault();cell.click();return}
      const dirMap={ArrowUp:[0,1],ArrowDown:[0,-1],ArrowLeft:[-1,0],ArrowRight:[1,0]};
      if(!dirMap[e.key])return;
      e.preventDefault();
      const[row,tier]=cell.dataset.yardSlot.split('|').map(Number);
      const[dr,dt]=dirMap[e.key];
      const target=document.querySelector(`[data-yard-slot="${row+dr}|${tier+dt}"]`);
      if(target)target.focus();
    });
  });
  document.getElementById('yardBayBody').querySelectorAll('[data-yard-list-container]').forEach(item=>{
    item.addEventListener('click',()=>{
      const match=inBay.find(l=>l.container===item.dataset.yardListContainer);
      if(match)openYardDetailPanel(match);
    });
  });
  document.getElementById('yardBayOverlay').classList.add('open');
}
function closeYardBayModal(){document.getElementById('yardBayOverlay')?.classList.remove('open')}
function openYardMapForContainer(container){
  const key=yardKey(container),loc=loadYardLocations()[key];
  if(!loc){showToast('No yard location logged for this container yet');return}
  openYardModal();
  switchYardTab('map');
  setTimeout(()=>{
    openYardBayModal(loc.stack,Number(loc.bay),loc.row,loc.tier);
    setTimeout(()=>{
      const cell=document.querySelector(`#yardBayBody [data-yard-slot="${loc.row}|${loc.tier}"]`);
      if(cell){cell.scrollIntoView({behavior:'smooth',block:'center'});applyColumnHighlight(loc.row,loc.tier)}
      openYardDetailPanel(loc);
    },120);
  },80);
}
let pendingRemoveMatch=null;
function handleLongPressRemove(match){
  if(navigator.vibrate)navigator.vibrate(30);
  pendingRemoveMatch=match;
  document.getElementById('yardRemoveChoiceSubtitle').textContent=`${match.container} — currently at ${yardLocationLabel(match)}`;
  document.getElementById('yardRemoveChoiceOverlay').classList.add('open');
}
function closeYardRemoveChoice(){document.getElementById('yardRemoveChoiceOverlay')?.classList.remove('open');pendingRemoveMatch=null}
async function confirmYardRemove(status){
  const match=pendingRemoveMatch;if(!match)return;
  closeYardRemoveChoice();
  try{
    await removeYardLocation(match.container,{status});
    mergeYardOnlyContainers();
    showToast(`✅ ${match.container} removed from yard — marked ${status}`);
    refreshYardModal();
  }catch(err){alert(err?.message||'Could not remove this location.')}
}
function openYardDetailPanel(match){
  const body=document.getElementById('yardDetailBody');if(!body)return;
  const when=new Date(match.updatedAt).toLocaleString('en-GB');
  const above=yardContainersAbove(match.stack,match.bay,match.row,match.tier);
  const below=yardContainersBelow(match.stack,match.bay,match.row,match.tier);
  const accessible=above.length===0;
  const dataRecord=DATA?.[yardKey(match.container)];
  const enriched=dataRecord&&!dataRecord._yardOnly?`<div class="yard-detail-row"><span>Status</span><span>${statusPill(currentStatus(dataRecord))}</span></div>`:'';
  body.innerHTML=`
    <div class="yard-detail-num">${esc(match.container)}</div>
    <div class="yard-detail-loc">📍 ${esc(yardLocationLabel(match))}</div>
    ${enriched}
    <div class="yard-detail-row"><span>Accessible</span><span>${accessible?'✅ YES':'⛔ NO'}</span></div>
    <div class="yard-detail-row"><span>Containers Above</span><span>${above.length}</span></div>
    <div class="yard-detail-row"><span>Containers Below</span><span>${below.length}</span></div>
    <div class="yard-detail-row"><span>Movement Status</span><span>${accessible?'✅ Ready to Move':`⛔ Blocked by ${above.length} container${above.length===1?'':'s'}`}</span></div>
    ${!accessible?`<div class="yard-move-assistant"><strong>Move in this order first:</strong><ol>${above.map(a=>`<li>Move <strong>${esc(a.container)}</strong> — currently Tier ${esc(a.tier)}</li>`).join('')}<li>Then move <strong>${esc(match.container)}</strong></li></ol></div>`:''}
    <div class="yard-detail-row"><span>Last updated</span><span>${esc(when)}</span></div>
    <div class="yard-detail-row"><span>Logged by</span><span>${esc(match.updatedBy||'—')}</span></div>
    ${match.note?`<div class="yard-detail-row"><span>Note</span><span>${esc(match.note)}</span></div>`:''}
    <div class="yard-detail-actions">
      <button type="button" class="users-mini-btn" id="yardDetailSearchBtn" style="color:var(--accent)">🔎 Open in Search</button>
      ${currentUserIsOperation()?`<button type="button" class="auth-submit" id="yardDetailMoveBtn" style="margin-top:0"${accessible?'':' disabled title="Blocked — move the containers above it first"'}>📍 Log New Move</button>`:''}
      ${currentUserIsOperation()?`<button type="button" class="users-mini-btn" id="yardDetailRemoveBtn" style="color:var(--red)">🗑️ Remove from Yard</button>`:''}
    </div>`;
  document.getElementById('yardDetailRemoveBtn')?.addEventListener('click',()=>{
    closeYardDetailPanel();
    handleLongPressRemove(match);
  });
  document.getElementById('yardDetailSearchBtn')?.addEventListener('click',()=>{
    closeYardDetailPanel();closeYardModal();
    doSearch(match.container);
  });
  document.getElementById('yardDetailMoveBtn')?.addEventListener('click',()=>{
    if(!accessible)return;
    closeYardDetailPanel();
    switchYardTab('log');
    const input=document.getElementById('yardMoveContainer');
    if(input){input.value=match.container;loadYardMoveHistoryFor(match.container)}
  });
  document.getElementById('yardDetailOverlay').classList.add('open');
}
function closeYardDetailPanel(){document.getElementById('yardDetailOverlay')?.classList.remove('open')}
function prepareYardLogForm(){
  const isOp=currentUserIsOperation();
  document.getElementById('yardOpDenied').style.display=isOp?'none':'block';
  document.getElementById('yardLogForm').style.display=isOp?'block':'none';
  if(!isOp)return;
  const cfg=loadYardConfig(),stacks=cfg?.stacks||[];
  const stackSel=document.getElementById('yardMoveStack');
  stackSel.innerHTML=stacks.length?stacks.map(st=>`<option value="${esc(st.name)}">${esc(st.name)}</option>`).join(''):'<option value="">No stacks defined</option>';
  updateYardBaySelect();
}
function updateYardBaySelect(){
  const cfg=loadYardConfig(),stackName=document.getElementById('yardMoveStack').value;
  const stack=(cfg?.stacks||[]).find(st=>st.name===stackName);
  const baySel=document.getElementById('yardMoveBay');
  baySel.innerHTML=stack?(stack.bays||[]).map(b=>`<option value="${b}">${yardBayLabel(b)}</option>`).join(''):'';
  updateYardRowTierSelects();
}
function updateYardRowTierSelects(){
  const cfg=loadYardConfig(),stackName=document.getElementById('yardMoveStack').value;
  const stack=(cfg?.stacks||[]).find(st=>st.name===stackName);
  const rowSel=document.getElementById('yardMoveRow');
  rowSel.innerHTML=stack?Array.from({length:stack.rows},(_,i)=>`<option value="${i+1}">${i+1}</option>`).join(''):'';
  updateYardTierOptions();
}
function updateYardTierOptions(){
  const cfg=loadYardConfig(),stackName=document.getElementById('yardMoveStack').value,bay=document.getElementById('yardMoveBay').value;
  const stack=(cfg?.stacks||[]).find(st=>st.name===stackName);
  const rowSel=document.getElementById('yardMoveRow'),tierSel=document.getElementById('yardMoveTier');
  const row=rowSel.value;
  const tiers=stack?Array.from({length:stack.tiers},(_,i)=>i+1).filter(t=>!(row&&bay&&yardLocationDisabled(stack,bay,row,t))):[];
  tierSel.innerHTML=tiers.map(t=>`<option value="${t}">${t}</option>`).join('');
  updateYardLocationPreview();
}
function updateYardLocationPreview(){
  const stack=document.getElementById('yardMoveStack')?.value,bay=document.getElementById('yardMoveBay')?.value,row=document.getElementById('yardMoveRow')?.value,tier=document.getElementById('yardMoveTier')?.value;
  const el=document.getElementById('yardLocationPreview');
  if(!el)return;
  el.textContent=stack&&bay&&row&&tier?`Location: ${yardLocationCode(stack,bay,row,tier)}`:'Location: —';
}
let lastYardAction=null;
async function handleYardMoveSubmit(){
  const containerInput=document.getElementById('yardMoveContainer'),stackSel=document.getElementById('yardMoveStack'),baySel=document.getElementById('yardMoveBay'),rowSel=document.getElementById('yardMoveRow'),tierSel=document.getElementById('yardMoveTier'),noteInput=document.getElementById('yardMoveNote'),err=document.getElementById('yardMoveError'),btn=document.getElementById('yardMoveSubmit');
  err.textContent='';btn.disabled=true;
  try{
    const prev=loadYardLocations()[yardKey(containerInput.value)]||null;
    const record=await logYardMove(containerInput.value,stackSel.value,baySel.value,rowSel.value,tierSel.value,noteInput.value);
    mergeYardOnlyContainers();
    showToast(`✅ ${record.container} logged at ${yardLocationLabel(record)}`);
    noteInput.value='';
    renderYardMap();
    loadYardMoveHistoryFor(record.container);
    lastYardAction={container:record.container,prev};
    showYardUndoBar(`Moved ${record.container} to ${yardLocationLabel(record)}.`);
  }catch(e){err.textContent=e?.message||'Could not log this move.'}
  finally{btn.disabled=false}
}
function showYardUndoBar(text){
  const bar=document.getElementById('yardUndoBar');if(!bar)return;
  document.getElementById('yardUndoText').textContent=text;
  bar.style.display='flex';
  clearTimeout(bar._timer);
  bar._timer=setTimeout(()=>{bar.style.display='none';lastYardAction=null},15000);
}
async function handleYardUndo(){
  if(!lastYardAction)return;
  const{container,prev}=lastYardAction;
  const bar=document.getElementById('yardUndoBar');
  try{
    if(prev){
      await logYardMove(container,prev.stack,prev.bay,prev.row,prev.tier,'Undo — reverted');
      showToast(`↩ ${container} reverted to ${yardLocationCode(prev.stack,prev.bay,prev.row,prev.tier)}`);
    }else{
      await removeYardLocation(container,{note:'Undo — removed'});
      showToast(`↩ ${container} removed (undo)`);
    }
    mergeYardOnlyContainers();
    renderYardMap();
    loadYardMoveHistoryFor(container);
  }catch(e){alert(e?.message||'Could not undo this move.')}
  lastYardAction=null;
  if(bar){clearTimeout(bar._timer);bar.style.display='none'}
}
async function loadYardMoveHistoryFor(container){
  const wrap=document.getElementById('yardMoveHistory');if(!wrap)return;
  if(!String(container||'').trim()){wrap.innerHTML='';return}
  const moves=await getYardMoveHistory(container);
  if(!moves.length){wrap.innerHTML='';return}
  wrap.innerHTML=`<div class="cal-section-title" style="margin-top:18px">Recent moves — ${esc(yardKey(container))}</div>`+moves.map(m=>{
    const when=m.movedAt?.toMillis?new Date(m.movedAt.toMillis()):new Date(m.movedAt||Date.now());
    const from=m.fromStack?yardLocationCode(m.fromStack,m.fromBay,m.fromRow,m.fromTier):'—';
    const to=yardLocationCode(m.toStack,m.toBay,m.toRow,m.toTier);
    return `<div class="yard-history-item">${esc(from)} → <strong>${esc(to)}</strong><div class="yh-meta">${when.toLocaleString('en-GB')} · ${esc(m.movedBy||'')}${m.note?' · '+esc(m.note):''}</div></div>`;
  }).join('');
}
function renderYardSetup(){
  if(!yardSetupDraft)yardSetupDraft=JSON.parse(JSON.stringify(loadYardConfig()||{stacks:[]}));
  if(!yardSetupDraft.stacks)yardSetupDraft.stacks=[];
  const list=document.getElementById('yardZonesList');if(!list)return;
  list.innerHTML=yardSetupDraft.stacks.length?yardSetupDraft.stacks.map((st,i)=>`<div class="yard-zone-row"><div><span class="yard-zone-label">Stack name</span><input data-zone-name data-idx="${i}" value="${esc(st.name)}"></div><div><span class="yard-zone-label">Bays (comma-separated)</span><input data-zone-bays data-idx="${i}" value="${esc((st.bays||[]).join(','))}"></div><div><span class="yard-zone-label">Rows</span><input data-zone-rows data-idx="${i}" type="number" min="1" max="99" value="${st.rows}"></div><div><span class="yard-zone-label">Tiers</span><input data-zone-tiers data-idx="${i}" type="number" min="1" max="9" value="${st.tiers}"></div><div><span class="yard-zone-label">Disabled locations (optional, e.g. 2:4:3)</span><input data-zone-disabled data-idx="${i}" value="${esc((st.disabledLocations||[]).map(d=>`${d.bay}:${d.row}:${d.tier}`).join(','))}" placeholder="bay:row:tier, e.g. 2:4:3"></div><div><span class="yard-zone-label">Locked bays (optional)</span><input data-zone-locked data-idx="${i}" value="${esc((st.lockedBays||[]).join(','))}" placeholder="e.g. 8,10"></div><button type="button" class="yard-mini-btn" data-remove-zone="${i}" style="margin-top:16px" title="Remove stack">✕</button></div>`).join(''):'<div class="yard-empty-note">No stacks yet — add one below, or load the preset above.</div>';
}
function loadYardPresetLayout(){
  const bays10=[2,4,6,8,10,12,14,16,18,20];
  yardSetupDraft={stacks:[
    {name:'A',bays:bays10.slice(),rows:4,tiers:3,disabledLocations:[{bay:2,row:4,tier:3}],lockedBays:[]},
    {name:'B',bays:bays10.slice(),rows:4,tiers:3,disabledLocations:[],lockedBays:[]},
    {name:'G',bays:bays10.slice(),rows:4,tiers:3,disabledLocations:[],lockedBays:[]},
    {name:'D',bays:bays10.slice(),rows:4,tiers:3,disabledLocations:[],lockedBays:[]}
  ]};
  renderYardSetup();
  showToast('Loaded Stack A/B/G/D — review then Save to publish');
}
async function handleSaveYardConfig(){
  const err=document.getElementById('yardConfigError'),btn=document.getElementById('yardSaveConfigBtn');
  err.textContent='';
  if(!yardSetupDraft||!yardSetupDraft.stacks.length){err.textContent='Add at least one stack first.';return}
  const names=yardSetupDraft.stacks.map(st=>st.name);
  if(names.some(n=>!n)){err.textContent='Every stack needs a name.';return}
  if(new Set(names).size!==names.length){err.textContent='Stack names must be unique.';return}
  if(yardSetupDraft.stacks.some(st=>!st.bays||!st.bays.length)){err.textContent='Every stack needs at least one bay number.';return}
  const admin=loadAdmin();
  if(!admin){err.textContent='Create the controller account first (see "I\'m the Controller" on the sign-in screen).';return}
  const pass=prompt('Enter the controller password to save the yard layout:');
  if(pass===null)return;
  btn.disabled=true;
  try{
    const ok=await verifyAdmin(admin.username,pass);
    if(!ok)throw new Error('Incorrect controller password.');
    await saveYardConfig(yardSetupDraft);
    showToast('✅ Yard layout saved');
    renderYardMap();
  }catch(e){err.textContent=e?.message||'Could not save the yard layout.'}
  finally{btn.disabled=false}
}

document.getElementById('headerClockBtn')?.addEventListener('click',openCalendarModal);
document.getElementById('calCloseBtn')?.addEventListener('click',closeCalendarModal);
document.getElementById('calOverlay')?.addEventListener('click',e=>{if(e.target.id==='calOverlay')closeCalendarModal()});
document.getElementById('calPrevBtn')?.addEventListener('click',()=>calShiftMonth(-1));
document.getElementById('calNextBtn')?.addEventListener('click',()=>calShiftMonth(1));
document.getElementById('calTodayBtn')?.addEventListener('click',calGoToday);
document.getElementById('headerManageUsersBtn')?.addEventListener('click',openUsersModal);
document.getElementById('sourceManageUsersBtn')?.addEventListener('click',openUsersModal);
document.getElementById('usersCloseBtn')?.addEventListener('click',closeUsersModal);
document.getElementById('usersOverlay')?.addEventListener('click',e=>{if(e.target.id==='usersOverlay')closeUsersModal()});
document.getElementById('addUserBtn')?.addEventListener('click',handleAddUser);
document.getElementById('usersList')?.addEventListener('click',handleUsersListClick);
document.getElementById('adminGateSubmit')?.addEventListener('click',handleAdminGateSubmit);
document.getElementById('adminGateUsername')?.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();document.getElementById('adminGatePassword')?.focus()}});
document.getElementById('adminGatePassword')?.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();handleAdminGateSubmit()}});
document.getElementById('adminGateConfirmPassword')?.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();handleAdminGateSubmit()}});
document.getElementById('changeAdminBtn')?.addEventListener('click',handleChangeAdmin);
document.getElementById('adminForgotLink')?.addEventListener('click',event=>{event.preventDefault();handleForgotAdmin()});
document.getElementById('headerYardBtn')?.addEventListener('click',()=>openYardModal());
document.getElementById('yardReportExcelBtn')?.addEventListener('click',downloadYardReportExcel);
document.getElementById('yardReportPdfBtn')?.addEventListener('click',downloadYardReportPDF);
document.getElementById('downloadBackupBtn')?.addEventListener('click',downloadFullBackup);
document.getElementById('copyControllerUidBtn')?.addEventListener('click',async()=>{
  const uid=document.getElementById('controllerUidText')?.dataset.uid;
  if(!uid){showToast('⚠️ Sign in with a real account first — see the note above');return}
  try{await navigator.clipboard.writeText(uid);showToast('📋 ID copied — see the setup guide for what to do with it')}
  catch(_){showToast('Could not copy automatically — select the ID text manually')}
});
document.getElementById('announcementPublishBtn')?.addEventListener('click',async()=>{
  const input=document.getElementById('announcementInput'),text=input.value.trim();
  if(!text){showToast('Type something to publish first');return}
  try{await publishAnnouncement(text);showToast('📢 Announcement published — visible to everyone signed in')}
  catch(err){alert(err?.message||'Could not publish the announcement.')}
});
document.getElementById('announcementClearBtn')?.addEventListener('click',async()=>{
  if(!confirm('Remove the current announcement for everyone?'))return;
  try{await publishAnnouncement('');document.getElementById('announcementInput').value='';showToast('Announcement cleared')}
  catch(err){alert(err?.message||'Could not clear the announcement.')}
});
document.getElementById('announcementDismissBtn')?.addEventListener('click',dismissAnnouncement);
document.getElementById('yardCloseBtn')?.addEventListener('click',closeYardModal);
document.getElementById('yardTabBackBtn')?.addEventListener('click',()=>switchYardTab('map'));
document.getElementById('yardChoiceFactoryBtn')?.addEventListener('click',()=>confirmYardRemove('IN SIDE FACTORY'));
document.getElementById('yardChoiceOutBtn')?.addEventListener('click',()=>confirmYardRemove('OUT'));
document.getElementById('yardRemoveChoiceCancelBtn')?.addEventListener('click',closeYardRemoveChoice);
document.getElementById('yardRemoveChoiceCloseBtn')?.addEventListener('click',closeYardRemoveChoice);
document.getElementById('yardRemoveChoiceOverlay')?.addEventListener('click',e=>{if(e.target.id==='yardRemoveChoiceOverlay')closeYardRemoveChoice()});
document.getElementById('yardBayBackBtn')?.addEventListener('click',closeYardBayModal);
document.getElementById('yardDetailBackBtn')?.addEventListener('click',closeYardDetailPanel);
document.getElementById('yardDetailCloseBtn')?.addEventListener('click',closeYardDetailPanel);
document.getElementById('yardDetailOverlay')?.addEventListener('click',e=>{if(e.target.id==='yardDetailOverlay')closeYardDetailPanel()});
document.getElementById('yardBayCloseBtn')?.addEventListener('click',closeYardBayModal);
document.getElementById('yardBayOverlay')?.addEventListener('click',e=>{if(e.target.id==='yardBayOverlay')closeYardBayModal()});
document.getElementById('yardOverlay')?.addEventListener('click',e=>{if(e.target.id==='yardOverlay')closeYardModal()});
document.querySelectorAll('.yard-tab').forEach(btn=>btn.addEventListener('click',()=>switchYardTab(btn.dataset.yardTab)));
document.getElementById('yardMoveStack')?.addEventListener('change',updateYardBaySelect);
document.getElementById('yardMoveBay')?.addEventListener('change',updateYardRowTierSelects);
document.getElementById('yardMoveRow')?.addEventListener('change',updateYardTierOptions);
document.getElementById('yardMoveTier')?.addEventListener('change',updateYardLocationPreview);
document.getElementById('yardMoveSubmit')?.addEventListener('click',handleYardMoveSubmit);
document.getElementById('yardUndoBtn')?.addEventListener('click',handleYardUndo);
document.getElementById('yardMoveContainer')?.addEventListener('blur',()=>{
  setTimeout(()=>{document.getElementById('yardMoveSuggestions').style.display='none'},150);
  loadYardMoveHistoryFor(document.getElementById('yardMoveContainer').value);
});
document.getElementById('yardMoveContainer')?.addEventListener('input',e=>{
  const box=document.getElementById('yardMoveSuggestions'),q=e.target.value;
  const matches=getMatches(q,10);
  if(!matches.length){box.style.display='none';return}
  box.innerHTML=matches.map(({key})=>{
    const d=DATA[key],s=currentStatus(d),loc=loadYardLocations()[key];
    const detail=loc?`📍 ${yardLocationLabel(loc)}`:(d?.cy?.customer||d?.customer?.customer||'');
    return`<div class="sugg-item" data-cntr="${esc(key)}"><span>${esc(key)}</span><span class="sugg-badge ${normStatus(s)==='OUT'?'sp-green':'sp-gray'}">${esc(s)}</span><span style="color:#B0BEC5;font-size:11px;margin-left:auto">${esc(detail)}</span></div>`;
  }).join('');
  box.style.display='block';
  box.querySelectorAll('[data-cntr]').forEach(item=>{
    item.addEventListener('mousedown',ev=>{
      ev.preventDefault();
      document.getElementById('yardMoveContainer').value=item.dataset.cntr;
      box.style.display='none';
      loadYardMoveHistoryFor(item.dataset.cntr);
    });
  });
});
document.getElementById('yardAddZoneBtn')?.addEventListener('click',()=>{
  if(!yardSetupDraft)yardSetupDraft=JSON.parse(JSON.stringify(loadYardConfig()||{stacks:[]}));
  if(!yardSetupDraft.stacks)yardSetupDraft.stacks=[];
  yardSetupDraft.stacks.push({name:String.fromCharCode(65+yardSetupDraft.stacks.length%26),bays:[2,4,6,8,10],rows:4,tiers:3,disabledLocations:[]});
  renderYardSetup();
});
document.getElementById('yardZonesList')?.addEventListener('input',e=>{
  const idx=e.target.dataset.idx;if(idx===undefined||!yardSetupDraft)return;
  const i=Number(idx);
  if(e.target.hasAttribute('data-zone-name'))yardSetupDraft.stacks[i].name=e.target.value.trim().toUpperCase();
  if(e.target.hasAttribute('data-zone-bays'))yardSetupDraft.stacks[i].bays=e.target.value.split(',').map(v=>parseInt(v.trim(),10)).filter(n=>!isNaN(n)&&n>0);
  if(e.target.hasAttribute('data-zone-rows'))yardSetupDraft.stacks[i].rows=Math.max(1,parseInt(e.target.value,10)||1);
  if(e.target.hasAttribute('data-zone-tiers'))yardSetupDraft.stacks[i].tiers=Math.max(1,parseInt(e.target.value,10)||1);
  if(e.target.hasAttribute('data-zone-disabled')){
    const list=[];
    e.target.value.split(',').forEach(triple=>{
      const parts=triple.split(':').map(v=>parseInt(v.trim(),10));
      if(parts.length===3&&parts.every(n=>!isNaN(n)))list.push({bay:parts[0],row:parts[1],tier:parts[2]});
    });
    yardSetupDraft.stacks[i].disabledLocations=list;
  }
  if(e.target.hasAttribute('data-zone-locked'))yardSetupDraft.stacks[i].lockedBays=e.target.value.split(',').map(v=>parseInt(v.trim(),10)).filter(n=>!isNaN(n)&&n>0);
});
document.getElementById('yardZonesList')?.addEventListener('click',e=>{
  const idx=e.target.dataset.removeZone;
  if(idx===undefined||!yardSetupDraft)return;
  yardSetupDraft.stacks.splice(Number(idx),1);
  renderYardSetup();
});
document.getElementById('yardLoadPresetBtn')?.addEventListener('click',loadYardPresetLayout);
document.getElementById('yardSaveConfigBtn')?.addEventListener('click',handleSaveYardConfig);
document.addEventListener('keydown',e=>{if(e.key==='Escape'){closeCalendarModal();closeUsersModal();closeYardModal();closeYardDetailPanel();closeYardBayModal()}});
tickClock();setInterval(tickClock,1000);

/* ── Auto sign-out after inactivity ── */
const IDLE_TIMEOUT_MS=30*60000;
let idleTimer=null;
function resetIdleTimer(){
  if(document.body.classList.contains('auth-locked'))return;
  clearTimeout(idleTimer);
  idleTimer=setTimeout(()=>{showToast('You were signed out after 30 minutes of inactivity');lockSystem()},IDLE_TIMEOUT_MS);
}
['mousemove','keydown','touchstart','click','scroll'].forEach(evt=>document.addEventListener(evt,resetIdleTimer,{passive:true}));
resetIdleTimer();

/* ── Dark mode ── */
const THEME_STORAGE_KEY='container_lookup_theme_v1';
function applyThemeIcon(){
  const dark=document.documentElement.classList.contains('dark-mode'),icon=dark?'☀️':'🌙';
  document.getElementById('themeToggleBtn')?.replaceChildren(document.createTextNode(icon));
  document.getElementById('authThemeToggleBtn')?.replaceChildren(document.createTextNode(icon));
}
function toggleTheme(){
  const dark=document.documentElement.classList.toggle('dark-mode');
  try{localStorage.setItem(THEME_STORAGE_KEY,dark?'dark':'light')}catch(_){}
  applyThemeIcon();
}
document.getElementById('themeToggleBtn')?.addEventListener('click',toggleTheme);
document.getElementById('authThemeToggleBtn')?.addEventListener('click',toggleTheme);
applyThemeIcon();

/* ── Language switcher (AR / EN / KO) ──
   Translates the static interface chrome (titles, labels, buttons, section headers).
   Business data pulled from the Excel workbooks (statuses, remarks, carrier names, etc.)
   stays exactly as sourced — translating it would risk breaking lookups/exports. */
const LANG_STORAGE_KEY='container_lookup_lang_v1';
const I18N={
  en:{appTitle:'Marsa',loginSubtitle:'Authorized users only — sign in to access container data and reports.',usernameLabel:'Username',passwordLabel:'Password',signIn:'Sign In',controllerLink:"👥 I'm the Controller — Manage Users",headerSubtitle:'CNTR Movement & Archive Search — 2026',statFinalSeal:'Final Seal',statHalfSeal:'Half Seal',statLocal:'Local',statPivotTotal:'Pivot Total',statEmpty:'Empty',changeFilesBtn:'Change Excel Files',usersBtn:'Users',yardBtn:'Yard',logoutBtn:'Logout',calTitle:'📅 Calendar & Week Number',usersTitle:'👥 Manage Users',yardTitle:'🏗️ Yard Operations',searchLabel:'Search by Container Number, Seal, Customer, Carrier, BC or LSP',searchPlaceholder:'e.g. ABCD1234567, seal, customer, carrier, BC or LSP',emptyTitle:'Search for a Container',emptySubtitle:'Enter a container number above to see all its data across movements, archive, CY management, customer records, and more.',notFoundTitle:'Container Not Found'},
  ar:{appTitle:'مرسى',loginSubtitle:'للمستخدمين المصرح لهم فقط — سجّل الدخول للوصول إلى بيانات وتقارير الحاويات.',usernameLabel:'اسم المستخدم',passwordLabel:'كلمة المرور',signIn:'تسجيل الدخول',controllerLink:'👥 أنا الكنترولر — إدارة المستخدمين',headerSubtitle:'بحث وأرشيف حركة الحاويات — 2026',statFinalSeal:'فاينال سيل',statHalfSeal:'هاف سيل',statLocal:'لوكال',statPivotTotal:'إجمالي البيفوت',statEmpty:'فاضية',changeFilesBtn:'تغيير ملفات الإكسل',usersBtn:'المستخدمين',yardBtn:'الساحة',logoutBtn:'تسجيل خروج',calTitle:'📅 الكالندر ورقم الأسبوع',usersTitle:'👥 إدارة المستخدمين',yardTitle:'🏗️ عمليات الساحة',searchLabel:'ابحث برقم الحاوية، السيل، العميل، الشركة، البي سي أو الـ LSP',searchPlaceholder:'مثال: ABCD1234567، السيل، العميل، الشركة، BC أو LSP',emptyTitle:'ابحث عن حاوية',emptySubtitle:'اكتب رقم الحاوية فوق عشان تشوف كل بياناتها — الحركة، الأرشيف، إدارة الـ CY، بيانات العميل وأكتر.',notFoundTitle:'الحاوية مش موجودة'},
  ko:{appTitle:'마르사',loginSubtitle:'승인된 사용자만 이용 가능 — 컨테이너 데이터 및 보고서에 접근하려면 로그인하세요.',usernameLabel:'사용자 이름',passwordLabel:'비밀번호',signIn:'로그인',controllerLink:'👥 저는 컨트롤러입니다 — 사용자 관리',headerSubtitle:'컨테이너 이동 및 보관 검색 — 2026',statFinalSeal:'파이널 씰',statHalfSeal:'하프 씰',statLocal:'로컬',statPivotTotal:'피벗 합계',statEmpty:'공컨테이너',changeFilesBtn:'엑셀 파일 변경',usersBtn:'사용자',yardBtn:'야드',logoutBtn:'로그아웃',calTitle:'📅 캘린더 및 주차',usersTitle:'👥 사용자 관리',yardTitle:'🏗️ 야드 운영',searchLabel:'컨테이너 번호, 씰, 고객, 선사, BC 또는 LSP로 검색',searchPlaceholder:'예: ABCD1234567, 씰, 고객, 선사, BC 또는 LSP',emptyTitle:'컨테이너 검색',emptySubtitle:'위에 컨테이너 번호를 입력하면 이동 내역, 보관, CY 관리, 고객 기록 등 모든 데이터를 확인할 수 있습니다.',notFoundTitle:'컨테이너를 찾을 수 없습니다'}
};
function loadLanguage(){try{return localStorage.getItem(LANG_STORAGE_KEY)||'en'}catch(_){return 'en'}}
function applyLanguage(lang){
  if(!I18N[lang])lang='en';
  try{localStorage.setItem(LANG_STORAGE_KEY,lang)}catch(_){}
  const dict=I18N[lang];
  document.querySelectorAll('[data-i18n]').forEach(el=>{const key=el.dataset.i18n;if(dict[key]!==undefined)el.textContent=dict[key]});
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el=>{const key=el.dataset.i18nPlaceholder;if(dict[key]!==undefined)el.placeholder=dict[key]});
  document.documentElement.setAttribute('lang',lang);
  document.querySelectorAll('[data-lang-btn]').forEach(btn=>btn.classList.toggle('active',btn.dataset.langBtn===lang));
  if(document.getElementById('calOverlay')?.classList.contains('open'))renderCalendarModal();
}
document.querySelectorAll('[data-lang-btn]').forEach(btn=>btn.addEventListener('click',()=>applyLanguage(btn.dataset.langBtn)));
applyLanguage(loadLanguage());

/* ── Avatar upload & "My Profile" — with a drag/zoom crop tool ── */
const AVATAR_CROP_SIZE=260,AVATAR_OUTPUT_SIZE=240;
let cropState=null;
function readFileAsImage(file){
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onerror=()=>reject(new Error('Could not read that image.'));
    reader.onload=()=>{
      const img=new Image();
      img.onerror=()=>reject(new Error('Could not load that image.'));
      img.onload=()=>resolve(img);
      img.src=reader.result;
    };
    reader.readAsDataURL(file);
  });
}
function clampCropOffsets(){
  if(!cropState)return;
  const{img,scale}=cropState;
  const dispW=img.width*scale,dispH=img.height*scale;
  const maxX=Math.max(0,(dispW-AVATAR_CROP_SIZE)/2),maxY=Math.max(0,(dispH-AVATAR_CROP_SIZE)/2);
  cropState.offsetX=Math.max(-maxX,Math.min(maxX,cropState.offsetX));
  cropState.offsetY=Math.max(-maxY,Math.min(maxY,cropState.offsetY));
}
function drawCrop(){
  if(!cropState)return;
  const canvas=document.getElementById('avatarCropCanvas');if(!canvas)return;
  const ctx=canvas.getContext('2d'),{img,scale,offsetX,offsetY}=cropState;
  ctx.clearRect(0,0,AVATAR_CROP_SIZE,AVATAR_CROP_SIZE);
  ctx.fillStyle='#EEF2F7';ctx.fillRect(0,0,AVATAR_CROP_SIZE,AVATAR_CROP_SIZE);
  const dispW=img.width*scale,dispH=img.height*scale;
  const x=AVATAR_CROP_SIZE/2-dispW/2+offsetX,y=AVATAR_CROP_SIZE/2-dispH/2+offsetY;
  ctx.drawImage(img,x,y,dispW,dispH);
}
async function openAvatarCropper(file){
  try{
    const img=await readFileAsImage(file);
    const minScale=Math.max(AVATAR_CROP_SIZE/img.width,AVATAR_CROP_SIZE/img.height);
    cropState={img,scale:minScale,minScale,offsetX:0,offsetY:0};
    const zoom=document.getElementById('avatarCropZoom');if(zoom)zoom.value=100;
    drawCrop();
    document.getElementById('avatarCropOverlay').classList.add('open');
  }catch(err){showToast('⚠️ '+(err?.message||'Could not load that image'))}
}
function closeAvatarCropper(){document.getElementById('avatarCropOverlay')?.classList.remove('open');cropState=null}
function wireCropCanvasDrag(){
  const canvas=document.getElementById('avatarCropCanvas');if(!canvas)return;
  let dragging=false,lastX=0,lastY=0;
  canvas.addEventListener('pointerdown',e=>{dragging=true;lastX=e.clientX;lastY=e.clientY;canvas.setPointerCapture(e.pointerId)});
  canvas.addEventListener('pointermove',e=>{
    if(!dragging||!cropState)return;
    cropState.offsetX+=e.clientX-lastX;cropState.offsetY+=e.clientY-lastY;
    lastX=e.clientX;lastY=e.clientY;
    clampCropOffsets();drawCrop();
  });
  const stop=()=>{dragging=false};
  canvas.addEventListener('pointerup',stop);canvas.addEventListener('pointercancel',stop);canvas.addEventListener('pointerleave',stop);
}
document.getElementById('avatarCropZoom')?.addEventListener('input',e=>{
  if(!cropState)return;
  cropState.scale=cropState.minScale*(Number(e.target.value)/100);
  clampCropOffsets();drawCrop();
});
function handleAvatarCropSave(){
  if(!cropState)return;
  const{img,scale,offsetX,offsetY}=cropState;
  const out=document.createElement('canvas');out.width=AVATAR_OUTPUT_SIZE;out.height=AVATAR_OUTPUT_SIZE;
  const ratio=AVATAR_OUTPUT_SIZE/AVATAR_CROP_SIZE,ctx=out.getContext('2d');
  const dispW=img.width*scale*ratio,dispH=img.height*scale*ratio;
  const x=AVATAR_OUTPUT_SIZE/2-dispW/2+offsetX*ratio,y=AVATAR_OUTPUT_SIZE/2-dispH/2+offsetY*ratio;
  ctx.drawImage(img,x,y,dispW,dispH);
  saveCroppedAvatar(out.toDataURL('image/jpeg',0.88));
  closeAvatarCropper();
}
async function saveCroppedAvatar(dataUrl){
  const session=currentSessionUser();if(!session||!session.user){showToast('Sign in first');return}
  try{
    await saveUserRecord(session.key,{...session.user,avatar:dataUrl});
    renderHeaderUser();
    document.getElementById('profileAvatarBig').innerHTML=avatarMarkup({...session.user,avatar:dataUrl});
    showToast('✅ Profile picture updated');
  }catch(err){showToast('⚠️ '+(err?.message||'Could not update your picture'))}
}
function currentSessionUser(){const key=storageGet(AUTH_SESSION_KEY);return key?{key,user:loadUsers()[key]}:null}
function avatarMarkup(user,fallbackSize){
  if(user?.avatar)return `<img src="${esc(user.avatar)}" alt="">`;
  const initial=esc((user?.username||'?').trim().charAt(0).toUpperCase()||'?');
  return initial;
}
function renderHeaderUser(){
  const session=currentSessionUser(),nameEl=document.getElementById('headerUserName'),avatarEl=document.getElementById('headerUserAvatar');
  updateDebugButtonVisibility();
  document.body.classList.toggle('no-export-perm',!currentUserCan('canExport'));
  document.body.classList.toggle('no-upload-perm',!currentUserCan('canUploadData'));
  if(!session||!session.user){if(nameEl)nameEl.textContent='—';if(avatarEl)avatarEl.innerHTML='👤';return}
  if(nameEl)nameEl.textContent=session.user.username;
  if(avatarEl)avatarEl.innerHTML=avatarMarkup(session.user);
}
function openProfileModal(){
  const session=currentSessionUser();
  if(!session||!session.user){showToast('Sign in first to manage your profile');return}
  document.getElementById('profileName').textContent=session.user.username;
  document.getElementById('profileMeta').textContent=[session.user.email,session.user.isOperation?'🏗️ Yard Operation account':null].filter(Boolean).join(' · ')||'Signed in';
  document.getElementById('profileAvatarBig').innerHTML=avatarMarkup(session.user);
  document.getElementById('profileOverlay').classList.add('open');
}
function closeProfileModal(){document.getElementById('profileOverlay')?.classList.remove('open')}
function handleAvatarFileChosen(e){
  const file=e.target.files?.[0];if(!file)return;
  openAvatarCropper(file);
  e.target.value='';
}
async function handleRemoveAvatar(){
  const session=currentSessionUser();if(!session||!session.user)return;
  const{avatar,...rest}=session.user;
  await saveUserRecord(session.key,rest);
  renderHeaderUser();
  document.getElementById('profileAvatarBig').innerHTML=avatarMarkup(rest);
  showToast('Profile picture removed');
}
wireCropCanvasDrag();
document.getElementById('headerUserBadge')?.addEventListener('click',openProfileModal);
document.getElementById('profileCloseBtn')?.addEventListener('click',closeProfileModal);
document.getElementById('profileOverlay')?.addEventListener('click',e=>{if(e.target.id==='profileOverlay')closeProfileModal()});
document.getElementById('profileAvatarInput')?.addEventListener('change',handleAvatarFileChosen);
document.getElementById('profileRemoveAvatarBtn')?.addEventListener('click',handleRemoveAvatar);
document.getElementById('avatarCropCloseBtn')?.addEventListener('click',closeAvatarCropper);
document.getElementById('avatarCropCancelBtn')?.addEventListener('click',closeAvatarCropper);
document.getElementById('avatarCropSaveBtn')?.addEventListener('click',handleAvatarCropSave);
document.getElementById('avatarCropOverlay')?.addEventListener('click',e=>{if(e.target.id==='avatarCropOverlay')closeAvatarCropper()});

/* ── Presence — "who has the system open right now" (Controller panel) ──
   Each signed-in device periodically stamps its account's lastSeenAt. With
   cloud sync enabled this is visible to every device; offline, it only
   reflects this device. */
const PRESENCE_ACTIVE_WINDOW_MS=5*60000;
async function touchPresence(){
  const session=currentSessionUser();if(!session||!session.user)return;
  try{await saveUserRecord(session.key,{...session.user,lastSeenAt:new Date().toISOString()})}catch(_){}
}
function timeAgoLabel(iso){
  if(!iso)return'a while ago';
  const ms=Date.now()-new Date(iso).getTime();
  if(ms<60000)return'just now';
  if(ms<3600000)return`${Math.round(ms/60000)}m ago`;
  return`${Math.round(ms/3600000)}h ago`;
}
function renderOnlineUsers(){
  const wrap=document.getElementById('controllerOnlineList');if(!wrap)return;
  const users=loadUsers(),mySession=storageGet(AUTH_SESSION_KEY);
  const online=Object.entries(users).filter(([,u])=>u.lastSeenAt&&(Date.now()-new Date(u.lastSeenAt).getTime())<PRESENCE_ACTIVE_WINDOW_MS)
    .sort(([,a],[,b])=>new Date(b.lastSeenAt)-new Date(a.lastSeenAt));
  wrap.innerHTML=online.length?online.map(([key,u])=>`<div class="cal-holiday-row"><span class="hub-avatar" style="width:26px;height:26px;font-size:11px;flex-shrink:0">${avatarMarkup(u)}</span><span class="chd-name">${esc(u.username)}${key===mySession?' (you)':''} ${u.isOperation?'🏗️':''}</span><span style="font-size:10.5px;color:var(--muted);flex-shrink:0">${esc(timeAgoLabel(u.lastSeenAt))}</span></div>`).join(''):
    `<div class="cal-holiday-empty">No one else is currently signed in${FIREBASE_ENABLED?'':' — cloud sync is off, so this only reflects this device'}.</div>`;
}
setInterval(()=>{if(!document.body.classList.contains('auth-locked'))touchPresence()},60000);

movementFileInput?.addEventListener('change',()=>updateSourceSelection('movement',movementFileInput.files?.[0]||null));
managementFileInput?.addEventListener('change',()=>updateSourceSelection('management',managementFileInput.files?.[0]||null));
loadSourcesBtn?.addEventListener('click',loadSelectedSources);
changeSourcesBtn?.addEventListener('click',openSourceScreen);
backToSystemBtn?.addEventListener('click',closeSourceScreen);

setupAuthentication();

if('serviceWorker' in navigator){
  window.addEventListener('load',()=>{
    navigator.serviceWorker.register('service-worker.js').catch(err=>console.error('Service worker registration failed',err));
  });
}


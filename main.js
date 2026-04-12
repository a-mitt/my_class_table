<script type="module">
import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore, doc, collection, setDoc, getDoc, getDocs, deleteDoc, writeBatch }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const provider = new GoogleAuthProvider();

// 日曜日まで対応
const DAYS=['月','火','水','木','金','土','日'];
const COLORS=['blue','teal','coral','green','amber','purple'];
const CHEX={blue:'#378ADD',teal:'#1D9E75',coral:'#D85A30',green:'#639922',amber:'#BA7517',purple:'#7F77DD'};

let uid=null, timetables=[], currentTtId=null, cellData={}, sc='blue';
let isLoadingTimetables = false;
let editingPeriod = null;
let editingTarget = null;
let currentAddType = 'course'; // 'course' | 'other'
let currentApp = 'timetable';

// カレンダー管理
let exceptions = {};
function getMonday(d) {
  const date = new Date(d);
  const day = date.getDay();
  const diff = date.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(date.setDate(diff));
}
function formatDate(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
let currentWeekStart = getMonday(new Date());
let calYear = currentWeekStart.getFullYear();
let calMonth = currentWeekStart.getMonth();

let sysSettings = { 
  periods: 5, 
  times: ['08:50-10:20','10:30-12:00','13:00-14:30','14:40-16:10','16:20-17:50'],
  showTeacher: true, showRoom: true, showMemo: true,
  displayDays: 6 // 5=金, 6=土, 7=日
};

let historyStack = [];
let historyIndex = -1;
let isHistoryRestoring = false;

// =========================================
// アプリ切り替え（時間割⇔フローチャート）
// =========================================
window.toggleAppSwitcher = () => {
  const sw = document.getElementById('app-switcher');
  sw.style.display = sw.style.display === 'none' ? 'block' : 'none';
};

window.switchApp = (appName) => {
  currentApp = appName;
  document.getElementById('app-switcher').style.display = 'none';
  if(appName === 'timetable') {
    document.getElementById('app-title-text').textContent = '時間割';
    document.getElementById('timetable-view').style.display = 'block';
    document.getElementById('flowchart-view').style.display = 'none';
    document.getElementById('timetable-header-controls').style.display = 'flex';
    document.getElementById('timetable-header-actions').style.display = 'flex';
  } else {
    document.getElementById('app-title-text').textContent = 'フローチャート';
    document.getElementById('timetable-view').style.display = 'none';
    document.getElementById('flowchart-view').style.display = 'block';
    document.getElementById('timetable-header-controls').style.display = 'none';
    document.getElementById('timetable-header-actions').style.display = 'none';
  }
};

const titleBtn = document.getElementById('app-title-btn');
let pressTimer;
titleBtn.addEventListener('mousedown', () => { pressTimer = setTimeout(toggleAppSwitcher, 500); });
titleBtn.addEventListener('mouseup', () => { clearTimeout(pressTimer); });
titleBtn.addEventListener('mouseleave', () => { clearTimeout(pressTimer); });
titleBtn.addEventListener('touchstart', (e) => { pressTimer = setTimeout(toggleAppSwitcher, 500); }, {passive:true});
titleBtn.addEventListener('touchend', () => { clearTimeout(pressTimer); });
titleBtn.addEventListener('click', () => { clearTimeout(pressTimer); toggleAppSwitcher(); });

document.addEventListener('click', (e) => {
  if(!e.target.closest('#app-title-btn') && !e.target.closest('#app-switcher')) {
    document.getElementById('app-switcher').style.display = 'none';
  }
});

// =========================================
// 認証・起動処理
// =========================================
document.getElementById('login-btn').onclick = () => signInWithPopup(auth, provider).catch(console.error);

onAuthStateChanged(auth, async user => {
  if(user){
    uid = user.uid;
    document.getElementById('login-screen').style.display='none';
    document.getElementById('main-screen').style.display='block';
    
    document.getElementById('drawer-name').textContent = user.displayName || 'ユーザー';
    document.getElementById('drawer-email').textContent = user.email || '';
    if(user.photoURL) {
      document.getElementById('drawer-avatar').src = user.photoURL;
      document.getElementById('drawer-avatar').style.display = 'block';
      document.getElementById('drawer-avatar-fallback').style.display = 'none';
    }
    
    await loadSettings();
    await loadExceptions();
    await loadTimetables();
  } else {
    uid=null;
    document.getElementById('login-screen').style.display='flex';
    document.getElementById('main-screen').style.display='none';
  }
});

// =========================================
// 設定・例外データ・カレンダー操作
// =========================================
async function loadSettings() {
  const snap = await getDoc(doc(db, 'users', uid, 'settings', 'main'));
  if(snap.exists()) sysSettings = { ...sysSettings, ...snap.data() };
  if(!sysSettings.displayDays) sysSettings.displayDays = 6;
  document.getElementById('set-display-days').value = sysSettings.displayDays;
  updateSettingUI();
}

async function saveSettings() {
  setSaving('設定保存中...');
  await setDoc(doc(db, 'users', uid, 'settings', 'main'), sysSettings, {merge: true});
  setSaving('');
}

window.changeDisplayDays = async (val) => {
  sysSettings.displayDays = parseInt(val);
  buildTable();
  await saveSettings();
};

async function loadExceptions() {
  const snap = await getDocs(collection(db, 'users', uid, 'exceptions'));
  exceptions = {};
  snap.forEach(d => { exceptions[d.id] = d.data(); });
}

window.toggleHoliday = async (dateStr, displayDate) => {
  const ex = exceptions[dateStr] || {};
  const isHol = ex.isHoliday || ex.type === 'holiday';
  if(!confirm(isHol ? `${displayDate} の「全休」を解除しますか？` : `${displayDate} を「全休（祝日・行事）」に設定しますか？\n通常の授業が非表示になります。`)) return;
  
  pushHistory();
  if(ex.type) delete ex.type;
  ex.isHoliday = !isHol;
  exceptions[dateStr] = ex;
  setSaving('保存中...');
  await setDoc(doc(db, 'users', uid, 'exceptions', dateStr), ex, {merge:true});
  setSaving('');
  buildTable();
};

window.toggleSet = async (key) => {
  sysSettings[key] = !sysSettings[key];
  updateSettingUI(); buildTable(); await saveSettings();
};

function updateSettingUI() {
  document.getElementById('tg-teacher').className = 'toggle-btn' + (sysSettings.showTeacher ? ' on' : '');
  document.getElementById('tg-room').className = 'toggle-btn' + (sysSettings.showRoom ? ' on' : '');
  document.getElementById('tg-memo').className = 'toggle-btn' + (sysSettings.showMemo ? ' on' : '');
  updatePromptText();
}

function updatePromptText() {
  let formatStr = "授業名,曜日(月火水木金土の1文字),時限(1〜" + sysSettings.periods + "の数字)";
  let exampleStr = "デザイン実習,月,1";
  if (sysSettings.showTeacher) { formatStr += ",担当教員名"; exampleStr += ",山田太郎"; }
  if (sysSettings.showRoom) { formatStr += ",教室"; exampleStr += ",101教室"; }
  const promptEl = document.getElementById('ptxt');
  if(promptEl) promptEl.textContent = `以下の時間割の画像を読み取り、CSV形式に変換してください。\n出力ルール：\n- ヘッダー行なし\n- 1行 = 1授業\n- 形式: ${formatStr}\n- 空きコマは出力しない\n- 記号等は不要\n出力例：\n${exampleStr}`;
}

window.changePeriod = async (delta) => {
  const newP = sysSettings.periods + delta;
  if(newP < 1 || newP > 10) return;
  sysSettings.periods = newP;
  if(delta > 0 && !sysSettings.times[newP - 1]) sysSettings.times[newP - 1] = '00:00-00:00';
  updatePromptText(); buildTable(); await saveSettings();
};

window.shiftWeek = (offset) => { currentWeekStart.setDate(currentWeekStart.getDate() + offset * 7); buildTable(); };
window.resetWeek = () => { currentWeekStart = getMonday(new Date()); buildTable(); };

// 月間カレンダー処理
window.openCalModal = () => {
  const d = new Date(currentWeekStart);
  d.setDate(d.getDate() + 3); // 木曜を基準に月を判定
  calYear = d.getFullYear();
  calMonth = d.getMonth();
  renderCal();
  document.getElementById('cal-selector').style.display = 'none';
  document.getElementById('cal-header-normal').style.display = 'flex';
  document.getElementById('cal-modal').classList.add('show');
};

window.closeCalModal = () => document.getElementById('cal-modal').classList.remove('show');

window.changeCalMonth = (delta) => {
  calMonth += delta;
  if(calMonth > 11) { calMonth = 0; calYear++; }
  if(calMonth < 0) { calMonth = 11; calYear--; }
  renderCal();
};

window.showCalSelector = () => {
  document.getElementById('cal-header-normal').style.display = 'none';
  document.getElementById('cal-selector').style.display = 'block';
  
  const ySel = document.getElementById('cal-sel-year'), mSel = document.getElementById('cal-sel-month');
  ySel.innerHTML = ''; mSel.innerHTML = '';
  for(let y = calYear - 5; y <= calYear + 5; y++) ySel.innerHTML += `<option value="${y}" ${y === calYear ? 'selected' : ''}>${y}</option>`;
  for(let m = 0; m < 12; m++) mSel.innerHTML += `<option value="${m}" ${m === calMonth ? 'selected' : ''}>${m+1}</option>`;
};

window.applyCalSelector = () => {
  calYear = parseInt(document.getElementById('cal-sel-year').value);
  calMonth = parseInt(document.getElementById('cal-sel-month').value);
  document.getElementById('cal-selector').style.display = 'none';
  document.getElementById('cal-header-normal').style.display = 'flex';
  renderCal();
};

function renderCal() {
  document.getElementById('cal-month-label').textContent = `${calYear}年 ${calMonth + 1}月`;
  const tbody = document.getElementById('cal-tbody');
  tbody.innerHTML = '';
  
  const firstDay = new Date(calYear, calMonth, 1);
  const lastDay = new Date(calYear, calMonth + 1, 0);
  let d = new Date(firstDay);
  d.setDate(d.getDate() - d.getDay()); // 日曜始まり
  const activeMonStr = formatDate(currentWeekStart);

  while (d <= lastDay || d.getDay() !== 0) {
    const tr = document.createElement('tr');
    tr.className = 'cal-week-row';
    const weekMon = getMonday(new Date(d));
    
    if (formatDate(weekMon) === activeMonStr) tr.style.background = '#e8f0fe';
    tr.onclick = () => { currentWeekStart = new Date(weekMon); buildTable(); closeCalModal(); };
    
    for (let i = 0; i < 7; i++) {
      const td = document.createElement('td');
      td.style.padding = '8px 4px'; td.textContent = d.getDate();
      if (d.getMonth() !== calMonth) td.style.color = '#ccc';
      else { if (i === 0) td.style.color = '#A32D2D'; if (i === 6) td.style.color = '#2a64b5'; }
      
      const today = new Date();
      if (d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate()) {
        td.innerHTML = `<span style="display:inline-block; width:24px; height:24px; line-height:24px; background:#1a1a1a; color:white; border-radius:50%;">${d.getDate()}</span>`;
      }
      tr.appendChild(td); d.setDate(d.getDate() + 1);
    }
    tbody.appendChild(tr);
  }
}

// =========================================
// データ・履歴管理 (Undo対応)
// =========================================
async function loadTimetables(){
  if(isLoadingTimetables) return;
  isLoadingTimetables = true;
  try {
    const snap = await getDocs(collection(db, 'users', uid, 'timetables'));
    timetables = [];
    snap.forEach(d => timetables.push({id:d.id, ...d.data()}));
    timetables.sort((a, b) => a.createdAt - b.createdAt);
    if(timetables.length === 0) await createTimetable('デフォルト');
    else {
      if(!currentTtId || !timetables.find(t => t.id === currentTtId)) currentTtId = timetables[0].id;
      renderTabs(); await loadCells();
    }
  } finally { isLoadingTimetables = false; }
}

async function createTimetable(name){
  const ref = doc(collection(db, 'users', uid, 'timetables'));
  await setDoc(ref, {name, createdAt: Date.now()});
  timetables.push({id:ref.id, name});
  currentTtId = ref.id; cellData = {}; initHistory(); renderTabs(); buildTable();
}

function renderTabs(){
  const tabs = document.getElementById('tt-tabs');
  tabs.innerHTML='';
  timetables.forEach(tt => {
    const wrap = document.createElement('div'); wrap.className = 'tab-wrap';
    const btn = document.createElement('button');
    btn.className = 'tt-tab' + (tt.id===currentTtId?' on':'');
    btn.textContent = tt.name;
    btn.onclick = async () => { if(currentTtId === tt.id) return; currentTtId = tt.id; await loadCells(); renderTabs(); };
    wrap.appendChild(btn);

    if(tt.id === currentTtId && timetables.length > 1){
      const del = document.createElement('span'); del.className = 'tab-del'; del.textContent = '✕';
      del.onclick = async () => {
        if(!confirm(`時間割「${tt.name}」を削除しますか？`)) return;
        setSaving('削除中...'); await deleteDoc(doc(db, 'users', uid, 'timetables', tt.id));
        timetables = timetables.filter(t => t.id !== tt.id); currentTtId = timetables[0].id;
        await loadCells(); renderTabs(); setSaving('');
      };
      wrap.appendChild(del);
    }
    tabs.appendChild(wrap);
  });
}

async function loadCells(){
  setSaving('読込中...');
  const snap = await getDocs(collection(db,'users',uid,'timetables',currentTtId,'cells'));
  cellData={}; snap.forEach(d => { cellData[d.id] = d.data().classes || []; });
  initHistory(); buildTable(); setSaving('');
}

function setSaving(msg){ document.getElementById('saving').textContent=msg; }
function g(d,p){ return cellData[d+'-'+p]||[]; }
function s(d,p,a){ cellData[d+'-'+p]=a; }

function initHistory() { historyStack = [JSON.stringify({cellData, exceptions})]; historyIndex = 0; updateUndoBtn(); }
function pushHistory() {
  if(isHistoryRestoring) return;
  historyStack = historyStack.slice(0, historyIndex + 1);
  historyStack.push(JSON.stringify({cellData, exceptions}));
  historyIndex++; updateUndoBtn();
}
function updateUndoBtn() {
  const u = document.getElementById('btn-undo'), r = document.getElementById('btn-redo');
  u.style.opacity = historyIndex > 0 ? '1' : '0.4'; u.style.pointerEvents = historyIndex > 0 ? 'auto' : 'none';
  r.style.opacity = historyIndex < historyStack.length - 1 ? '1' : '0.4'; r.style.pointerEvents = historyIndex < historyStack.length - 1 ? 'auto' : 'none';
}

window.undo = async () => { if (historyIndex > 0) { historyIndex--; await applyHistory(); } };
window.redo = async () => { if (historyIndex < historyStack.length - 1) { historyIndex++; await applyHistory(); } };
async function applyHistory() {
  isHistoryRestoring = true; setSaving('復元中...');
  const past = JSON.parse(historyStack[historyIndex]);
  const allCellKeys = new Set([...Object.keys(cellData), ...Object.keys(past.cellData||{})]);
  const allExKeys = new Set([...Object.keys(exceptions), ...Object.keys(past.exceptions||{})]);
  
  cellData = JSON.parse(JSON.stringify(past.cellData||{})); exceptions = JSON.parse(JSON.stringify(past.exceptions||{}));
  buildTable(); updateUndoBtn();

  const batch = writeBatch(db);
  for(let k of allCellKeys) batch.set(doc(db,'users',uid,'timetables',currentTtId,'cells',k), {classes: cellData[k] || []});
  for(let k of allExKeys) batch.set(doc(db,'users',uid,'exceptions',k), exceptions[k] || {});
  await batch.commit();
  setSaving(''); isHistoryRestoring = false;
}

async function saveCell(d, p){
  if(isHistoryRestoring) return;
  setSaving('保存中...'); await setDoc(doc(db,'users',uid,'timetables',currentTtId,'cells', d+'-'+p), {classes: cellData[d+'-'+p]||[]}); setSaving('');
}

// =========================================
// テーブル構築・描画（単発予定対応）
// =========================================
function buildTable(){
  const tb=document.getElementById('tb'); tb.innerHTML='';
  document.getElementById('week-label').textContent = `${currentWeekStart.getFullYear()}年${currentWeekStart.getMonth()+1}月`;
  
  const theadRow = document.getElementById('tt-head');
  theadRow.innerHTML = '<th style="width:60px; border-right:1px solid #eee;"></th>';
  const currentDays = [];
  
  for(let i=0; i<sysSettings.displayDays; i++){
    const d = new Date(currentWeekStart); d.setDate(d.getDate() + i);
    const dStr = formatDate(d); currentDays.push({ dateStr: dStr });
    
    const ex = exceptions[dStr] || {};
    const isHol = ex.isHoliday || ex.type === 'holiday';
    const th = document.createElement('th');
    th.className = 'day-header'; th.style.cursor = 'pointer';
    let dColor = (i===5)?'#2a64b5' : (i===6)?'#A32D2D' : '#333';
    
    th.innerHTML = `<div style="font-size:11px; color:#888; font-weight:400;">${d.getMonth()+1}/${d.getDate()}</div>
      <div style="font-size:14px; margin-top:2px; color:${isHol ? '#A32D2D' : dColor};">${DAYS[i]}</div>
      ${isHol ? '<div style="font-size:10px; color:#A32D2D; font-weight:400; margin-top:2px;">休み</div>' : ''}`;
    th.onclick = () => toggleHoliday(dStr, `${d.getMonth()+1}月${d.getDate()}日`);
    theadRow.appendChild(th);
  }

  const pCount = sysSettings.periods, pTimes = sysSettings.times;
  const mPeriod = document.getElementById('m-period');
  if(mPeriod) {
    mPeriod.innerHTML = '';
    for(let i=1; i<=pCount; i++) mPeriod.innerHTML += `<option value="${i}">${i}限</option>`;
  }
  
  const mDay = document.getElementById('m-day');
  if(mDay) {
    mDay.innerHTML = '';
    for(let i=0; i<sysSettings.displayDays; i++) mDay.innerHTML += `<option value="${i}">${DAYS[i]}曜</option>`;
  }

  for(let p=1; p<=pCount; p++){
    const tr=document.createElement('tr');
    const tl=document.createElement('td'); tl.className='pl'; tl.title='右クリックで時間を変更';
    tl.innerHTML=`<strong>${p}限</strong><span style="font-size:10px;">${pTimes[p-1] || '--:--'}</span>`;
    tl.addEventListener('contextmenu', e => onTimeCtx(e, p, pTimes[p-1]));
    let tt3; tl.addEventListener('touchstart', e => { tt3=setTimeout(()=>onTimeCtx({preventDefault:()=>{}}, p, pTimes[p-1]), 500); },{passive:true});
    tl.addEventListener('touchend',()=>clearTimeout(tt3));
    tr.appendChild(tl);
    
    currentDays.forEach((dayObj, di)=>{
      const cell=document.createElement('td'); cell.className='cell';
      cell.dataset.d=di; cell.dataset.p=p; cell.dataset.date=dayObj.dateStr;
      
      const isHol = exceptions[dayObj.dateStr] && (exceptions[dayObj.dateStr].isHoliday || exceptions[dayObj.dateStr].type === 'holiday');
      if(isHol) cell.style.background = '#f7f7f7';
      
      cell.addEventListener('contextmenu',onCtx);
      let tt2; cell.addEventListener('touchstart',e=>{tt2=setTimeout(()=>onCtx({preventDefault:()=>{},currentTarget:cell,clientX:e.touches[0].clientX,clientY:e.touches[0].clientY}),500);},{passive:true});
      cell.addEventListener('touchend',()=>clearTimeout(tt2));
      
      rc(cell, di, p, dayObj.dateStr);
      tr.appendChild(cell);
    });
    tb.appendChild(tr);
  }
}

function rc(cell, d, p, dateStr){
  cell.innerHTML='';
  const ex = exceptions[dateStr] || {};
  const isHol = ex.isHoliday || ex.type === 'holiday';
  if(isHol) return;

  const renderChip = (c, iStr, type) => {
    if(c.hidden) return;
    let dHtml = '';
    const st = sysSettings.showTeacher && c.teacher, sr = sysSettings.showRoom && c.room, sm = sysSettings.showMemo && c.memo;
    if(st || sr) dHtml += `<div style="display:flex; justify-content:space-between; border-top:0.5px solid rgba(0,0,0,0.08); margin-top:4px; padding-top:4px; font-size:10px;"><span style="opacity:0.8; font-weight:500;">${st ? c.teacher : ''}</span><span style="opacity:0.8;">${sr ? c.room : ''}</span></div>`;
    if(sm) dHtml += `<div style="border-top:0.5px solid rgba(0,0,0,0.08); margin-top:4px; padding-top:4px; font-size:10px; white-space:pre-wrap; opacity:0.75;">${c.memo}</div>`;

    const ch=document.createElement('div');
    ch.className=`chip chip-${c.color||'blue'} c-edit`;
    
    let badge = '';
    if(type === 'single') {
      ch.style.border = '1.5px dashed #1a1a1a';
      ch.style.boxShadow = '0 2px 4px rgba(0,0,0,0.05)';
      badge = '<div class="single-badge">📅 この日のみ</div>';
    } else if (c.itemType === 'other') {
      badge = '<div class="single-badge" style="background:#e8f0fe; color:#1a73e8;">💼 毎週の予定</div>';
    }

    ch.dataset.d = d; ch.dataset.p = p; ch.dataset.i = iStr; ch.dataset.type = type; ch.dataset.date = dateStr;
    ch.title = 'クリックして編集';
    ch.innerHTML=`<div style="pointer-events:none;">${badge}<div style="font-weight:600;font-size:13px;">${c.name}</div>${dHtml}</div>
      <span class="cdel" data-d="${d}" data-p="${p}" data-i="${iStr}" data-type="${type}" title="完全に削除" style="pointer-events:auto;">✕</span>`;
    cell.appendChild(ch);
  };

  g(d,p).forEach((c,i) => renderChip(c, String(i), 'normal'));
  if(ex.singles && ex.singles[p]) renderChip(ex.singles[p], 'single', 'single');
}

// =========================================
// クリック・メニュー制御
// =========================================
document.addEventListener('click',e=>{
  const del=e.target.closest('.cdel');
  if(del){
    if(!confirm("この予定を完全に削除しますか？")) return;
    pushHistory();
    const d=+del.dataset.d, p=+del.dataset.p, iStr=del.dataset.i, type=del.dataset.type, dateStr=del.closest('.chip').dataset.date;
    if(type === 'single') {
      delete exceptions[dateStr].singles[p];
      setDoc(doc(db, 'users', uid, 'exceptions', dateStr), exceptions[dateStr], {merge:true});
    } else {
      const a=g(d,p); a.splice(parseInt(iStr),1); s(d,p,a); saveCell(d,p);
    }
    buildTable(); return;
  }
  
  const chip=e.target.closest('.c-edit');
  if(chip){
    const d=+chip.dataset.d, p=+chip.dataset.p, iStr=chip.dataset.i, type=chip.dataset.type, dateStr=chip.dataset.date;
    showAdd(d, p, iStr, type, dateStr); return;
  }
  if(!e.target.closest('#ctx')) document.getElementById('ctx').classList.remove('show');
});

function onCtx(e){
  e.preventDefault();
  const cell=e.currentTarget; const d=+cell.dataset.d, p=+cell.dataset.p, dateStr=cell.dataset.date;
  
  document.getElementById('ctx-t').textContent=`${DAYS[d]}曜 ${p}限`;
  const cd=document.getElementById('ctx-cs'); cd.innerHTML='';
  const cs=g(d,p);
  
  if(!cs.length){
    cd.innerHTML='<div style="font-size:12px;color:#bbb;padding:0 14px;">登録された毎週の予定なし</div>';
  } else {
    cs.forEach((c,ci)=>{
      const row=document.createElement('div'); row.className='ccr';
      row.innerHTML=`<span class="ck ${c.hidden ? '' : 'on'}">✓</span><span class="chip-${c.color||'blue'}" style="padding:2px 6px;border-radius:4px;font-size:12px;opacity:${c.hidden ? 0.5 : 1};flex:1;">${c.name}</span>`;
      row.onclick=(ev)=>{
        ev.stopPropagation(); pushHistory(); c.hidden = !c.hidden; s(d,p,cs); buildTable(); saveCell(d,p);
      };
      cd.appendChild(row);
    });
  }
  
  document.getElementById('ctx-single-txt').textContent = `${dateStr.split('-')[1]}/${dateStr.split('-')[2]}だけの予定を追加`;
  document.getElementById('ctx-add-normal').onclick=()=>{ document.getElementById('ctx').classList.remove('show'); showAdd(d,p,null,'normal'); };
  document.getElementById('ctx-add-single').onclick=()=>{ document.getElementById('ctx').classList.remove('show'); showAdd(d,p,null,'single',dateStr); };
  
  const ctx=document.getElementById('ctx');
  ctx.style.left=Math.min(e.clientX,window.innerWidth-240)+'px';
  ctx.style.top=Math.min(e.clientY,window.innerHeight-200)+'px';
  ctx.classList.add('show');
}

// =========================================
// 予定追加・編集モーダル
// =========================================
window.setAddType = (type) => {
  currentAddType = type;
  document.getElementById('type-course').classList.toggle('on', type === 'course');
  document.getElementById('type-other').classList.toggle('on', type === 'other');
  
  if(type === 'course') {
    document.getElementById('m-name').placeholder = "授業名";
    document.getElementById('m-teacher').placeholder = "担当教員";
  } else {
    document.getElementById('m-name').placeholder = "予定の名前 (例: バイト、サークル)";
    document.getElementById('m-teacher').placeholder = "担当者 / 関連先";
  }
};

window.showAdd = (d, p, iStr = null, type = 'normal', dateStr = null) => {
  editingTarget = { d, p, iStr, type, dateStr };
  
  document.getElementById('m-day').value = d !== null ? d : 0;
  document.getElementById('m-period').value = p !== null ? p : 1;
  document.getElementById('m-day').disabled = (type === 'single');
  document.getElementById('add-modal-title').textContent = (type === 'single') ? `単発の予定 (${dateStr})` : '毎週の予定';
  
  // 単発の場合は「種類」選択を隠す（単発予定であることを優先するため）
  document.getElementById('add-type-seg').style.display = (type === 'single') ? 'none' : 'flex';
  document.getElementById('add-type-header').style.display = (type === 'single') ? 'none' : 'block';

  if (iStr !== null) {
    let c = {};
    if (type === 'single') c = (exceptions[dateStr] && exceptions[dateStr].singles) ? exceptions[dateStr].singles[p] : {};
    else c = g(d, p)[parseInt(iStr)];
    
    document.getElementById('m-name').value = c.name || '';
    document.getElementById('m-teacher').value = c.teacher || '';
    document.getElementById('m-room').value = c.room || '';
    document.getElementById('m-memo').value = c.memo || '';
    sc = c.color || 'blue';
    setAddType(c.itemType || 'course');
  } else {
    document.getElementById('m-name').value=''; document.getElementById('m-teacher').value='';
    document.getElementById('m-room').value=''; document.getElementById('m-memo').value=''; sc='blue'; 
    setAddType('course');
  }
  
  bcr(); document.getElementById('add-modal').classList.add('show');
  setTimeout(()=>document.getElementById('m-name').focus(),100);
};

window.closeAdd = () => document.getElementById('add-modal').classList.remove('show');
function bcr(){
  const r=document.getElementById('cr'); r.innerHTML='';
  COLORS.forEach(c=>{ const dot=document.createElement('div'); dot.className='cd'+(c===sc?' sel':''); dot.style.background=CHEX[c]; dot.onclick=()=>{sc=c;bcr();}; r.appendChild(dot); });
}

window.saveC = async () => {
  const name=document.getElementById('m-name').value.trim(); if(!name)return;
  const teacher=document.getElementById('m-teacher').value.trim();
  const room=document.getElementById('m-room').value.trim();
  const memo=document.getElementById('m-memo').value.trim();
  const newD=parseInt(document.getElementById('m-day').value);
  const newP=parseInt(document.getElementById('m-period').value);

  pushHistory();
  const newItem = {name, teacher, room, memo, color:sc, hidden:false, itemType: currentAddType};
  const { type, dateStr, d:oldD, p:oldP, iStr } = editingTarget;

  if (type === 'single') {
    if(!exceptions[dateStr]) exceptions[dateStr] = {};
    if(!exceptions[dateStr].singles) exceptions[dateStr].singles = {};
    if (iStr !== null && oldP !== newP && exceptions[dateStr].singles[oldP]) delete exceptions[dateStr].singles[oldP];
    exceptions[dateStr].singles[newP] = newItem;
    
    setSaving('保存中...');
    await setDoc(doc(db, 'users', uid, 'exceptions', dateStr), exceptions[dateStr], {merge:true});
    setSaving('');
  } else {
    if (iStr !== null) {
      const oldA = g(oldD, oldP);
      newItem.hidden = oldA[parseInt(iStr)].hidden;
      if (oldD === newD && oldP === newP) { oldA[parseInt(iStr)] = newItem; s(newD, newP, oldA); saveCell(newD, newP); }
      else { oldA.splice(parseInt(iStr), 1); s(oldD, oldP, oldA); saveCell(oldD, oldP); const newA = g(newD, newP); newA.push(newItem); s(newD, newP, newA); saveCell(newD, newP); }
    } else {
      const a = g(newD, newP); a.push(newItem); s(newD, newP, a); saveCell(newD, newP); 
    }
  }

  buildTable(); closeAdd();
};

// =========================================
// その他機能（時間設定・CSV等）
// =========================================
const hOpts = Array.from({length:24}, (_,i) => `<option value="${String(i).padStart(2,'0')}">${String(i).padStart(2,'0')}</option>`).join('');
const mOpts = Array.from({length:12}, (_,i) => `<option value="${String(i*5).padStart(2,'0')}">${String(i*5).padStart(2,'0')}</option>`).join('');
document.getElementById('tm-sh').innerHTML = document.getElementById('tm-eh').innerHTML = hOpts;
document.getElementById('tm-sm').innerHTML = document.getElementById('tm-em').innerHTML = mOpts;

window.onTimeCtx = (e, p, timeStr) => {
  e.preventDefault(); editingPeriod = p; document.getElementById('tm-title').textContent = `${p}限の時間帯`;
  let sh='08', sm='50', eh='10', em='20';
  if(timeStr && timeStr.includes('-')){ const [start, end] = timeStr.split('-'); [sh, sm] = start.split(':'); [eh, em] = end.split(':'); }
  document.getElementById('tm-sh').value = sh.padStart(2,'0'); document.getElementById('tm-sm').value = sm.padStart(2,'0');
  document.getElementById('tm-eh').value = eh.padStart(2,'0'); document.getElementById('tm-em').value = em.padStart(2,'0');
  document.getElementById('time-modal').classList.add('show');
};

window.closeTimeModal = () => document.getElementById('time-modal').classList.remove('show');
window.saveTime = async () => {
  if(!editingPeriod) return;
  sysSettings.times[editingPeriod - 1] = `${document.getElementById('tm-sh').value}:${document.getElementById('tm-sm').value}-${document.getElementById('tm-eh').value}:${document.getElementById('tm-em').value}`;
  closeTimeModal(); buildTable(); await saveSettings();
};

window.openImp = () => document.getElementById('imp-modal').classList.add('show');
window.closeImp = () => document.getElementById('imp-modal').classList.remove('show');
window.stab = (t) => {
  document.getElementById('pane-prompt').style.display=t==='prompt'?'block':'none';
  document.getElementById('pane-csv').style.display=t==='csv'?'block':'none';
  document.getElementById('s-prompt').classList.toggle('on',t==='prompt'); document.getElementById('s-csv').classList.toggle('on',t==='csv');
};
window.copyP = () => navigator.clipboard.writeText(document.getElementById('ptxt').textContent).then(()=>alert('コピーしました'));

window.doImport = async () => {
  const raw=document.getElementById('csv-in').value.trim(); const dm={月:0,火:1,水:2,木:3,金:4,土:5,日:6}; let cnt=0,sk=0;
  if(!raw) return; pushHistory();
  raw.split('\n').forEach(line=>{
    const pts=line.split(',').map(x=>x.trim()); if(pts.length<3){sk++;return;}
    let teacher='', room='', idx=3;
    if (sysSettings.showTeacher && pts.length > idx) { teacher = pts[idx]; idx++; }
    if (sysSettings.showRoom && pts.length > idx) { room = pts[idx]; }
    const d=dm[pts[1]],p=parseInt(pts[2]); if(d===undefined||isNaN(p)||p<1||p>sysSettings.periods){sk++;return;}
    const a=g(d,p); a.push({name:pts[0],teacher,room,memo:'',color:'blue',hidden:false,itemType:'course'}); s(d,p,a); cnt++;
  });
  buildTable(); const batch = writeBatch(db);
  Object.keys(cellData).forEach(k => batch.set(doc(db,'users',uid,'timetables',currentTtId,'cells',k), {classes: cellData[k]}));
  await batch.commit();
  document.getElementById('ir').textContent=`${cnt}件追加${sk?'（'+sk+'行スキップ）':''}`;
  if(cnt>0)setTimeout(window.closeImp,1200);
};

const drwOverlay = document.getElementById('drawer-overlay'), sDrawer = document.getElementById('side-drawer');
document.getElementById('account-btn').onclick = () => { drwOverlay.classList.add('show'); sDrawer.classList.add('show'); };
const closeDrw = () => { drwOverlay.classList.remove('show'); sDrawer.classList.remove('show'); };
document.getElementById('drawer-close').onclick = closeDrw; drwOverlay.onclick = closeDrw;
document.getElementById('drawer-logout').onclick = () => { closeDrw(); signOut(auth); };
['add-modal','imp-modal','time-modal', 'cal-modal'].forEach(id => {
  const el = document.getElementById(id); el.addEventListener('click', e => { if(e.target === el) el.classList.remove('show'); });
});
</script>

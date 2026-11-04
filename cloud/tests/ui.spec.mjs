import { test, expect } from '@playwright/test';

const subject = '中学数学';
const term = {
  id: 1, name: '冬期講習', start_date: '2026-12-21', end_date: '2027-01-03',
  dates: Array.from({length:14}, (_,i)=>new Date(Date.UTC(2026,11,21+i)).toISOString().slice(0,10)),
  periods: [2,3,4,5,6], closed_dates: [], accepting: true,
  period_times: {2:{start:'10:00',end:'11:00'},3:{start:'11:10',end:'12:10'}},
};
const slots = term.dates.flatMap(date=>term.periods.map(period=>({date,period})));

async function fixture(page, { teacher = false, setup = () => {} } = {}) {
  const state = {
    assignments: [{id:11,student_id:1,teacher_id:1,teacher_name:'担当講師',table_id:'A',subject,date:term.dates[0],period:2}],
    note: '', version: 1, cursor: 1, events: [], writes: [], slowReads: 0, slowWrites: 0, failReads: false, failPatch: false, plan: [], failComiru: false, failPost: false, failTermsReload: false, termReads: 0, boardDelays: {}, tableIds: ['A','B'], failSettings: false, requests: [], studentProfile: {}, teachers: [], failSlots: false, failAvailability: false,
    calendarTeachers: [{id:1,name:'担当講師',name_kana:'たんとうこうし',active:true,subjects:[subject,'中学英語']}],
    calendarTeacherSlots: null, calendarStudentSlots: null, nextAssignmentId: 22, comiruConfigured: true,
    deletedTerms: [], termDeleted: false, termVersion: 1, deleteFailure: false, teacherLinked: true,
  };
  setup(state);
  const students = () => [1,2].map(id=>({id,name:id===1?'生徒一':'生徒二',...(id===1?state.studentProfile:{}),subjects:[subject,'中学英語'],status:'調整中',display_status:'調整中',has_error:false,assignment_count:state.assignments.filter(a=>a.student_id===id).length,entered:true}));
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const method = request.method();
    state.requests.push({path,method,search:new URL(request.url()).search});
    const body = ['POST','PUT','PATCH','DELETE'].includes(method) ? request.postDataJSON() : null;
    const write = method !== 'GET';
    if (write) {
      state.writes.push({path,method,body});
      if(state.slowWrites) await new Promise(r=>setTimeout(r,state.slowWrites));
    } else if(state.slowReads && /assign\/|comiru\/status|\/version$/.test(path)) {
      await new Promise(r=>setTimeout(r,state.slowReads));
    }
    const boardId = /\/assign\/students\/(\d+)$/.exec(path)?.[1];
    if (boardId && state.boardDelays[boardId]) await new Promise(r=>setTimeout(r,state.boardDelays[boardId]));
    const send = (json, status=200) => route.fulfill({status,contentType:'application/json',body:JSON.stringify(json)});
    if(state.failReads && !write && /assign\/(students|changes)$/.test(path)) return send({error:'一覧の通信エラー'},503);
    if(path==='/api/me') return send({user:{email:'test@example.invalid'},is_staff:true,teacher:teacher&&state.teacherLinked?{id:1}:null});
    if(path==='/api/meta') return send({subjects:[subject,'中学英語'],periods:term.periods,period_labels:{2:'2限',3:'3限',4:'4限',5:'5限',6:'6限'},table_ids:state.tableIds,grades:['小1','小2','小3','小4','小5','小6','中1','中2','中3','高1','高2','高3','その他']});
    if(path==='/api/teacher/profile') return send({teacher:{id:1,name:'担当講師',subjects:[subject],google_email:'test@example.invalid'}});
    if(path==='/api/teacher/terms') return send([term,{...term,id:2,name:'春期講習'}]);
    if(/^\/api\/teacher\/terms\/\d+$/.test(path)) {
      if(write) {state.note=body.note;state.teacherSlots=body.slots;return send({updated_at:'2026-11-03T10:00:00Z',first_submission:false});}
      return send({term:{...term,id:Number(path.split('/').at(-1))},slots:state.teacherSlots??slots,note:state.note,updated_at:'2026-11-03T09:00:00Z'});
    }
    if(path==='/api/admin/settings') {
      if(write) {
        if(state.failSettings) return send({error:'席Bに授業が登録されています'},409);
        state.tableIds=Array.from({length:body.table_count},(_,i)=>{let n=i+1,label='';while(n>0){n--;label=String.fromCharCode(65+n%26)+label;n=Math.floor(n/26);}return label;});
      }
      return send({table_ids:state.tableIds});
    }
    if(path==='/api/admin/terms') {
      if(write) return send({...term,...body,id:7},201);
      state.termReads++;
      if(state.failTermsReload && state.termReads>1) return send({error:'一覧の再取得に失敗'},503);
      if(new URL(request.url()).searchParams.get('deleted')==='1') return send(state.deletedTerms);
      return send([...(state.termDeleted?[]:[term]),{...term,id:2,name:'春期講習'}]);
    }
    if(path.endsWith('/delete-preview')) return send({name:term.name,version:state.termVersion,assignments:state.assignments.length,students:2,teachers:1,comiru:0});
    if(/^\/api\/admin\/terms\/\d+$/.test(path)&&method==='DELETE') {
      if(state.deleteFailure) return send({error:'講習が変更されています'},409);
      state.termDeleted=true;state.deletedTerms=[{...term,deleted_at:'2026-11-03T13:00:00Z'}];return send({ok:true});
    }
    if(path.endsWith('/restore')) {state.termDeleted=false;state.deletedTerms=[];return send({...term,accepting:false});}
    if(/^\/api\/admin\/terms\/\d+$/.test(path) && write) return send({...term,...body});
    if(path.endsWith('/version')) return send({version:state.version,term});
    const keys = slots.map(s=>`${s.date}#${s.period}`);
    const snapStudents = () => students().map(s=>({...s,name_kana:s.name_kana??'',grade:s.grade??'',note:s.id===1?state.note:'',entered:true}));
    if(path.endsWith('/assign/snapshot')) return send({cursor:state.cursor,version:state.version,term,table_ids:state.tableIds,
      teachers:state.calendarTeachers,teacher_slots:state.calendarTeacherSlots??Object.fromEntries(state.calendarTeachers.map(t=>[t.id,keys])),
      students:snapStudents(),student_slots:state.calendarStudentSlots??{1:keys,2:keys},
      assignments:state.assignments.map(({id,student_id,teacher_id,table_id,subject,date,period})=>({id,student_id,teacher_id,table_id,subject,date,period}))});
    if(path.endsWith('/assign/changes')) {
      const since=Number(new URL(request.url()).searchParams.get('since'));
      return send({reload:false,cursor:state.cursor,events:state.events.filter(e=>e.id>since)});
    }
    if(/\/assign\/students\/\d+\/info$/.test(path)) {const id=Number(path.split('/').at(-2));return send({student:snapStudents().find(s=>s.id===id),slots:state.calendarStudentSlots?.[id]??keys});}
    if(/\/assign\/teachers\/\d+\/info$/.test(path)) return send({teacher:{id:1,name:'担当講師',name_kana:'',subjects:[subject,'中学英語']},slots:keys});
    if(path.endsWith('/assign/students')) return send(students());
    if(/\/assign\/students\/\d+$/.test(path)) {
      const id=Number(path.split('/').at(-1));
      const assignments=state.assignments.filter(a=>a.student_id===id);
      const subject_counts={};for(const a of assignments)subject_counts[a.subject]=(subject_counts[a.subject]??0)+1;
      return send({student:{...students().find(s=>s.id===id),note:state.note},availability:slots,assignments,subject_counts,version:state.version});
    }
    if(path.endsWith('/assign/slot-summary')) return send(slots.map(s=>({...s,free_teacher_count:1,total_teacher_count:1})));
    if(path.endsWith('/assign/conflicts')) return send([]);
    if(path.endsWith('/comiru/plan')) {
      const id=Number(new URL(request.url()).searchParams.get('student_id'));
      return send({items:state.plan.filter(i=>!id||i.student_id==null||i.student_id===id),verified:true});
    }
    if(path.endsWith('/comiru/apply')) return state.failComiru ? send({error:'通信エラー'},503) : send({results:body.keys.map(key=>({key,ok:true,message:'登録しました'}))});
    if(path==='/api/admin/comiru/status') return send({configured:false});
    if(path.endsWith('/comiru/status')) return send({configured:state.comiruConfigured,pending_total:state.assignments.length,students:{1:{pending:state.assignments.length,registered:0}}});
    if(path.endsWith('/assign/used-tables')) return send({used_table_ids:[]});
    if(path.endsWith('/assign/candidates')) return send([{teacher_id:1,name:'担当講師',assignment_count:1,has_conflict:false}]);
    if(/\/assign\/teachers\/\d+\/slots$/.test(path)) return state.failSlots ? send({error:'予定取得が遅れています'},503) : send({availability:slots,busy:[]});
    if(path.endsWith('/assignments') && method==='POST') {
      if(state.failPost) return send({error:'一時的な保存エラー'},503);
      state.version++;
      const used=state.assignments.filter(x=>x.student_id!==body.student_id&&x.date===body.date&&x.period===body.period).map(x=>x.table_id);
      const a={...body,table_id:body.table_id==='auto'?state.tableIds.find(t=>!used.includes(t)):body.table_id,id:state.nextAssignmentId++,teacher_name:'担当講師',version:state.version};
      state.assignments=state.assignments.filter(x=>!(x.student_id===a.student_id&&x.date===a.date&&x.period===a.period));
      state.assignments.push(a);state.events.push({id:++state.cursor,kind:'assignment',payload:a});return send(a,201);
    }
    if(/\/assignments\/\d+$/.test(path)) {
      if(method==='PATCH'&&state.failPatch)return send({error:'移動先にはすでに授業があります'},409);
      if(method==='PATCH'&&state.failAvailability)return send({error:'講師がこの日時に来られません'},409);
      const id=Number(path.split('/').at(-1));state.version++;
      if(method==='DELETE') {state.assignments=state.assignments.filter(a=>a.id!==id);state.events.push({id:++state.cursor,kind:'assignment_deleted',payload:{id}});return send({ok:true,version:state.version});}
      const a=state.assignments.find(a=>a.id===id);Object.assign(a,body,{table_id:body.table_id==='auto'?a.table_id:body.table_id});state.events.push({id:++state.cursor,kind:'assignment',payload:a});return send({...a,version:state.version});
    }
    if(path==='/api/admin/comiru/status') return send({configured:false});
    if(path.endsWith('/students')) return send(students());
    if(/\/students\/\d+$/.test(path)) {
      if(write){state.note=body.note;if(body.name_kana!==undefined)state.studentProfile.name_kana=body.name_kana;if(body.grade!==undefined)state.studentProfile.grade=body.grade;return send({ok:true,updated_at:'2026-11-03T10:00:00Z'});}
      return send({term,student:students()[0],subjects:[subject],slots,note:state.note,updated_at:'2026-11-03T09:00:00Z'});
    }
    if(path==='/api/admin/teachers')return send(state.teachers.filter(t=>Boolean(t.hidden)===(new URL(request.url()).searchParams.get('hidden')==='1')));
    if(path==='/api/admin/link-requests')return send([]);
    if(/\/teachers\/\d+\/profile$/.test(path)){state.teachers[0].name_kana=body.name_kana;return send({ok:true});}
    if(/\/teachers\/\d+\/login-email$/.test(path)){state.teachers[0].login_email_override=body.email;return send({ok:true,email:body.email});}
    if(/\/teachers\/\d+\/visibility$/.test(path)){state.teachers.find(t=>t.id===Number(path.split('/').at(-2))).hidden=body.hidden;return send({ok:true});}
    if(/\/teachers\/\d+\/availability$/.test(path)){
      state.proxyWrites=[...(state.proxyWrites??[]),body];
      if(state.proxyStale) return send({error:'講師本人かほかの事務の方が、先にこの講師の予定を保存しています。'},409);
      state.proxySlots=body.slots;state.teacherRev=(state.teacherRev??3)+1;
      state.history=[{id:9,actor_role:'staff',actor_email:'staff@example.invalid',added:[],removed:[{date:'2026-12-21',period:2}],note_before:null,note_after:null,reason:body.reason,created_at:'2026-11-04T01:00:00Z'},...(state.history??[])];
      return send({ok:true,changed:true,rev:state.teacherRev,slot_count:body.slots.length});
    }
    if(/\/teachers\/\d+$/.test(path))return send({term,slots:state.proxySlots??slots,note:'',updated_at:'2026-11-03T09:00:00Z',rev:state.teacherRev??3,history:state.history??[],added:[],removed:[]});
    throw new Error(`Unhandled fixture: ${method} ${path}`);
  });
  await page.goto(teacher?'/':'/admin.html');
  await expect(page.getByRole('heading',{name:teacher?'講習の予定入力':'講習管理',exact:true})).toBeVisible();
  if(teacher&&!state.teacherLinked) await expect(page.getByRole('heading',{name:'ログイン用メールの登録が必要です'})).toBeVisible();
  else await expect(page.locator(teacher?'.cal-cell.on':'.assign-toolbar').first()).toBeVisible();
  return state;
}

const cell = (page,date,period=2) => page.locator(`td[data-key="${date}#${period}"]`);

test('講師の欄と表示は通信を待たず、受け取りの通信エラーを保存失敗として扱わない', async({page})=>{
  const state=await fixture(page);
  state.slowReads=2500;state.requests=[];
  await cell(page,term.dates[1]).click();
  await page.getByRole('button',{name:/担当講師/}).filter({has:page.locator('kbd')}).click();
  await expect(cell(page,term.dates[1]).locator('.pill')).toContainText('担当講師',{timeout:500});
  expect(state.requests.filter(r=>/candidates|used-tables|slot-summary/.test(r.path))).toHaveLength(0);
  await expect(page.locator('.assignment-save-status')).toContainText('保存済み');
  await expect(page.getByRole('button',{name:'↶ 元に戻す'})).toBeEnabled();
  state.failReads=true;
  await expect(page.locator('.assignment-save-status')).toContainText('通信できませんでした',{timeout:6000});
  expect(state.writes.filter(w=>w.method==='POST')).toHaveLength(1);
  expect(await cell(page,term.dates[1]).textContent()).toContain('担当講師');
});

test('割り当て画面から予定を編集でき、保存中の追加入力を未保存のまま残す',async({page})=>{
  const state=await fixture(page);state.slowWrites=500;
  await page.getByRole('button',{name:'予定・科目を編集'}).click();
  const modal=page.locator('.modal');
  await expect(modal.getByRole('heading')).toHaveText('生徒一 の予定');
  await modal.getByLabel('備考',{exact:true}).fill('先に保存する内容');
  await modal.getByRole('button',{name:'保存する',exact:true}).click();
  await expect(modal.getByRole('button',{name:'保存中…'})).toBeVisible();
  await modal.getByLabel('備考',{exact:true}).fill('保存中の追加変更');
  await expect(modal.locator('.status')).toContainText('保存していない変更');
  await expect(modal.getByRole('button',{name:'保存する',exact:true})).toBeEnabled();
  expect(state.note).toBe('先に保存する内容');
  page.once('dialog',d=>d.dismiss());
  await modal.getByRole('button',{name:'閉じる',exact:true}).click();
  await expect(modal).toBeVisible();
  await modal.getByRole('button',{name:'保存する',exact:true}).click();
  await expect(modal.getByRole('button',{name:'保存済み',exact:true})).toBeVisible();
  await modal.getByRole('button',{name:'閉じる',exact:true}).click();
  await expect(modal).toHaveCount(0);
  await expect(page.locator('.assign-toolbar')).toContainText('保存中の追加変更');
});

test('講習設定のタブ・講習切り替えで未保存の変更を保護する',async({page})=>{
  await fixture(page);
  await page.getByRole('button',{name:'設定',exact:true}).click();
  await page.getByLabel('講習名', {exact:true}).fill('変更中');
  page.once('dialog',d=>d.dismiss());
  await page.getByRole('button',{name:'時間割',exact:true}).click();
  await expect(page.getByLabel('講習名',{exact:true})).toHaveValue('変更中');
  page.once('dialog',d=>d.dismiss());
  await page.locator('select').first().selectOption('2');
  await expect(page.locator('select').first()).toHaveValue('1');
  await expect(page.getByLabel('講習名',{exact:true})).toHaveValue('変更中');
  page.once('dialog',d=>d.accept());
  await page.getByRole('button',{name:'時間割',exact:true}).click();
  await expect(page.locator('.assign-toolbar')).toBeVisible();
});

test('スマホで連続入力の終了が見え、科目を変えたら連続入力を解除する',async({page})=>{
  await page.setViewportSize({width:320,height:844});
  await fixture(page);
  await page.locator('.teacher-chip').first().click();
  const end=page.getByRole('button',{name:'連続入力を終了（Esc）'});
  await expect(end).toBeVisible();
  const box=await end.boundingBox();expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(320);
  await page.locator('.assign-toolbar select').first().selectOption('中学英語');
  await expect(end).toHaveCount(0);
  await page.screenshot({path:test.info().outputPath('mobile.png'),fullPage:true});
});

test('移動はPATCH一回で行い、失敗したら元のコマに戻して履歴に残さない',async({page})=>{
  const state=await fixture(page);state.failPatch=true;
  const source=page.locator('.pill').first();
  const target=cell(page,term.dates[1]);
  const from=await source.boundingBox(),to=await target.boundingBox();
  await page.mouse.move(from.x+from.width/2,from.y+from.height/2);
  await page.mouse.down();await page.waitForTimeout(150);
  await page.mouse.move(to.x+to.width/2,to.y+to.height/2,{steps:10});
  await page.mouse.up();
  await expect(page.locator('.toast')).toContainText('移動先にはすでに授業');
  expect(state.writes.map(w=>w.method)).toEqual(['PATCH']);
  await expect(cell(page,term.dates[0]).locator('.pill')).toContainText('担当講師');
  await expect(page.getByRole('button',{name:'↶ 元に戻す'})).toBeDisabled();
});

test('講師の保存中の追加入力と、キャンセルした講習切り替えを正しく表示する',async({page})=>{
  const state=await fixture(page,{teacher:true});state.slowWrites=500;
  const note=page.getByLabel('備考',{exact:true});
  await note.fill('提出内容');await page.getByRole('button',{name:'保存する',exact:true}).click();
  await expect(page.getByRole('button',{name:'保存中…'})).toBeVisible();
  await note.fill('追加した内容');
  await expect(page.locator('#save-status')).toContainText('保存していない変更');
  await expect(page.getByRole('button',{name:'保存する',exact:true})).toBeEnabled();
  expect(state.note).toBe('提出内容');
  page.once('dialog',d=>d.dismiss());
  await page.getByRole('button',{name:'春期講習'}).click();
  await expect(page.locator('[data-term-id="1"]')).toHaveClass(/on/);
  await expect(page.locator('[data-term-id="2"]')).not.toHaveClass(/on/);
  await expect(note).toHaveValue('追加した内容');
});


test('削除はすぐ消えて一回だけ送り、元に戻す失敗時にも再試行できる', async({page})=>{
  const state=await fixture(page);state.slowWrites=500;
  await cell(page,term.dates[0]).hover();
  const del=cell(page,term.dates[0]).getByRole('button',{name:'この割り当てを削除',exact:true});
  await del.click();
  await expect(cell(page,term.dates[0]).locator('.pill')).toHaveCount(0,{timeout:300});
  await expect(del).toHaveCount(0);
  await expect(page.locator('.assignment-save-status')).toContainText('保存済み');
  expect(state.writes.filter(w=>w.method==='DELETE')).toHaveLength(1);
  state.failPost=true;
  await page.getByRole('button',{name:'↶ 元に戻す'}).click();
  await expect(page.locator('.toast')).toContainText('元に戻せませんでした');
  await expect(page.getByRole('button',{name:'↶ 元に戻す'})).toBeEnabled();
  state.failPost=false;
  await page.getByRole('button',{name:'↶ 元に戻す'}).click();
  await expect(cell(page,term.dates[0]).locator('.pill')).toContainText('担当講師');
  await expect(page.getByRole('button',{name:'↷ やり直す'})).toBeEnabled();
});

test('comiru反映中に閉じる操作を防ぎ、通信失敗時は未確認件数を残す',async({page})=>{
  const state=await fixture(page);state.failComiru=true;state.slowWrites=500;
  state.plan=Array.from({length:9},(_,i)=>({key:`1#2026-12-${21+i}#2`,op:'add',student_name:'生徒一',date:`2026-12-${21+i}`,period:2,teacher_name:'担当講師',comiru_subject:'数学'}));
  await page.getByRole('button',{name:'comiru反映を確認',exact:true}).click();
  page.once('dialog',d=>d.accept());
  await page.getByRole('button',{name:'反映する（9件）'}).click();
  await page.getByRole('button',{name:'閉じる',exact:true}).click();
  await expect(page.locator('.modal')).toBeVisible();
  await expect(page.locator('.modal')).toContainText('9件の結果を確認できていません');
  expect(state.writes.filter(w=>w.path.endsWith('/comiru/apply'))).toHaveLength(1);
  await page.getByRole('button',{name:'閉じる',exact:true}).click();
  await expect(page.locator('.modal')).toHaveCount(0);
});


test('講習作成後の一覧取得が失敗しても、保存の再試行で講習を二重作成しない',async({page})=>{
  const state=await fixture(page);
  await page.getByRole('button',{name:'設定',exact:true}).click();
  await page.getByRole('button',{name:'＋ 新しい講習を作る'}).click();
  await page.getByLabel('講習名',{exact:true}).fill('新規講習');
  await page.getByLabel('開始日',{exact:true}).fill('2027-03-21');
  await page.getByLabel('終了日',{exact:true}).fill('2027-03-28');
  state.failTermsReload=true;state.slowWrites=300;
  await page.getByRole('button',{name:'講習を作る',exact:true}).click();
  await expect(page.getByLabel('講習名',{exact:true})).toBeDisabled();
  await expect(page.getByRole('button',{name:'保存する',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'保存する',exact:true}).click();
  await expect(page.getByRole('button',{name:'保存する',exact:true})).toBeEnabled();
  expect(state.writes.map(w=>[w.method,w.path])).toEqual([['POST','/api/admin/terms'],['PUT','/api/admin/terms/7']]);
});


test('生徒の切り替えは通信を待たずにすぐ表示する',async({page})=>{
  const state=await fixture(page);state.slowReads=2500;state.requests=[];
  const picker=page.getByPlaceholder('生徒を検索');
  await picker.fill('生徒二');await page.locator('.suggest-item').filter({hasText:'生徒二'}).click();
  await expect(page.getByPlaceholder('生徒を検索')).toHaveValue('生徒二',{timeout:300});
  await expect(cell(page,term.dates[0]).locator('.pill')).toHaveCount(0);
  await picker.fill('生徒一');await page.locator('.suggest-item').filter({hasText:'生徒一'}).click();
  expect(state.requests.filter(r=>/\/assign\/students\/\d+$/.test(r.path))).toHaveLength(0);
  await expect(page.getByPlaceholder('生徒を検索')).toHaveValue('生徒一');
  await page.waitForTimeout(600);
  await expect(page.getByPlaceholder('生徒を検索')).toHaveValue('生徒一');
  await expect(cell(page,term.dates[0]).locator('.pill')).toContainText('担当講師');
  expect(state.writes).toHaveLength(0);
});


test('連続入力は押した瞬間に表示して裏で保存し、連打も全部受け付け、失敗したら元に戻す',async({page})=>{
  const state=await fixture(page);
  await page.locator('.teacher-chip').first().click();
  await expect(page.getByRole('button',{name:'連続入力を終了（Esc）'})).toBeVisible();
  state.requests=[];state.slowWrites=1000;
  const targets=[1,2,3].map(i=>cell(page,term.dates[i]));
  for(const t of targets) await t.click();
  for(const t of targets) await expect(t.locator('.pill')).toContainText('担当講師',{timeout:300});
  await expect(targets[0]).toHaveClass(/pending/);
  await expect(page.locator('.assignment-save-status')).toContainText('保存中');
  await expect(page.locator('.assignment-save-status')).toContainText('保存済み',{timeout:6000});
  await expect(targets[2]).not.toHaveClass(/pending/);
  expect(state.writes.filter(w=>w.method==='POST')).toHaveLength(3);
  expect(state.requests.filter(r=>r.path.endsWith('/assign/used-tables'))).toHaveLength(0);
  expect(state.writes[0].body.table_id).toBe('auto');
  state.failPost=true;state.slowWrites=300;
  await cell(page,term.dates[4]).click();
  await expect(cell(page,term.dates[4]).locator('.pill')).toContainText('担当講師',{timeout:300});
  await expect(page.locator('.toast')).toContainText('一時的な保存エラー');
  await expect(cell(page,term.dates[4]).locator('.pill')).toHaveCount(0);
});

test('座席設定でAA以降まで増やし、割り当ての席選択に反映する',async({page})=>{
  const state=await fixture(page);
  await page.getByRole('button',{name:'設定',exact:true}).click();
  await page.getByRole('button',{name:'座席設定',exact:true}).click();
  await page.getByLabel('座席数',{exact:true}).fill('27');
  await expect(page.locator('.seat-preview .badge')).toHaveCount(27);
  await expect(page.locator('.seat-preview')).toContainText('AA');
  await page.getByRole('button',{name:'座席設定を保存'}).click();
  await expect(page.getByRole('status')).toContainText('保存済み：27席');
  expect(state.tableIds.at(-1)).toBe('AA');
  await page.screenshot({path:test.info().outputPath('settings.png'),fullPage:true});
  await page.getByRole('button',{name:'時間割',exact:true}).click();
  await cell(page,term.dates[1]).click();
  await expect(page.locator('.popover select option[value="AA"]')).toHaveCount(1);
  await page.screenshot({path:test.info().outputPath('seat-options.png'),fullPage:true});
});

test('使用中の席を減らす操作が拒否されたら、設定を保存済みにしない',async({page})=>{
  const state=await fixture(page);state.failSettings=true;
  await page.getByRole('button',{name:'設定',exact:true}).click();
  await page.getByRole('button',{name:'座席設定',exact:true}).click();
  await page.getByLabel('座席数',{exact:true}).fill('1');
  await page.getByRole('button',{name:'座席設定を保存'}).click();
  await expect(page.locator('.toast')).toContainText('席Bに授業');
  await expect(page.getByRole('status')).toContainText('未保存');
  expect(state.tableIds).toEqual(['A','B']);
  page.once('dialog',d=>d.dismiss());
  await page.getByRole('button',{name:'時間割',exact:true}).click();
  await expect(page.getByLabel('座席数',{exact:true})).toHaveValue('1');
});

test('生徒の予定画面でふりがなと学年を編集できる',async({page})=>{
  const state=await fixture(page);
  await page.getByRole('button',{name:'予定・科目を編集'}).click();
  const modal=page.locator('.modal');
  await modal.getByLabel('ふりがな',{exact:true}).fill('あおい');
  await modal.getByRole('combobox',{name:'学年',exact:true}).selectOption('小1');
  await page.screenshot({path:test.info().outputPath('student-grade.png'),fullPage:true});
  await modal.getByRole('button',{name:'保存する',exact:true}).click();
  await expect(modal.getByRole('button',{name:'保存済み',exact:true})).toBeVisible();
  expect(state.studentProfile).toEqual({name_kana:'あおい',grade:'小1'});
  await modal.getByRole('button',{name:'閉じる',exact:true}).click();
  await page.getByPlaceholder('生徒を検索').focus();
  await expect(page.locator('.suggest-item').first()).toContainText('小1');
});


test('講師の詳細画面でふりがなを編集できる',async({page})=>{
  const state=await fixture(page);
  state.teachers=[{id:1,name:'担当講師',name_kana:'たんとうこうし',subjects:subject,linked:false,hidden:false,submitted_at:'2026-11-03T09:00:00Z',slot_count:10}];
  await page.getByRole('button',{name:'名簿・予定',exact:true}).click();
  await page.getByRole('button',{name:'講師',exact:true}).click();
  await page.getByRole('button',{name:'詳細',exact:true}).click();
  const modal=page.locator('.modal');
  await modal.getByLabel('ふりがな（あいうえお順に使用）',{exact:true}).fill('あおき');
  await modal.getByRole('button',{name:'ふりがなを保存',exact:true}).click();
  await expect(page.locator('.toast')).toContainText('ふりがなを保存しました');
  expect(state.teachers[0].name_kana).toBe('あおき');
  await modal.getByRole('button',{name:'閉じる',exact:true}).click();
  await expect(modal).toHaveCount(0);
});


async function dragWithoutWaiting(page, from, to) {
  const a=await from.boundingBox(),b=await to.boundingBox();
  await page.mouse.move(a.x+a.width/2,a.y+a.height/2);
  await page.mouse.down();
  await page.mouse.move(b.x+b.width/2,b.y+b.height/2,{steps:5});
  await page.mouse.up();
}

test('ドラッグでの移動は通信を待たずにすぐ動き、保存時にサーバーでも確認する',async({page})=>{
  const state=await fixture(page);state.slowWrites=1000;
  state.requests=[];
  const target=cell(page,term.dates[1]);
  await dragWithoutWaiting(page,cell(page,term.dates[0]).locator('.pill'),target);
  await expect(target.locator('.pill')).toContainText('担当講師',{timeout:300});
  await expect(target).toHaveClass(/pending/);
  await expect(cell(page,term.dates[0]).locator('.pill')).toHaveCount(0);
  await expect(target).not.toHaveClass(/pending/,{timeout:4000});
  await expect(target.locator('.pill')).toContainText('担当講師');
  expect(state.writes[0].body.strict_availability).toBe(true);
  expect(state.requests.filter(r=>/\/teachers\/\d+\/slots$/.test(r.path))).toHaveLength(0);
  await expect(page.locator('.toast')).not.toContainText('置けません');
});

test('予定が合わずドラッグ保存に失敗したら、元のコマに戻して理由を出す',async({page})=>{
  const state=await fixture(page);state.failAvailability=true;state.slowWrites=600;
  const target=cell(page,term.dates[1]);
  await dragWithoutWaiting(page,cell(page,term.dates[0]).locator('.pill'),target);
  await expect(target).toHaveClass(/pending/,{timeout:300});
  await expect(page.locator('.toast')).toContainText('講師がこの日時に来られません');
  await expect(target).not.toHaveClass(/pending/);
  await expect(target.locator('.pill')).toHaveCount(0);
  await expect(cell(page,term.dates[0]).locator('.pill')).toHaveCount(1);
});

test('主メニューを3つにまとめ、名簿と設定をそれぞれの中から開ける',async({page})=>{
  await fixture(page);
  await expect(page.getByRole('navigation',{name:'主な画面'}).getByRole('button')).toHaveText(['時間割','名簿・予定','設定']);
  await expect(page.getByRole('button',{name:'座席設定',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'名簿・予定',exact:true}).click();
  await expect(page.getByRole('navigation',{name:'名簿・予定の種類'}).getByRole('button')).toHaveText(['講師','生徒']);
  await page.getByRole('button',{name:'生徒',exact:true}).click();
  await expect(page.getByRole('heading',{name:/^生徒（入力済み/})).toBeVisible();
  await page.getByRole('button',{name:'時間割',exact:true}).click();
  await page.getByRole('button',{name:'名簿・予定',exact:true}).click();
  await expect(page.getByRole('button',{name:'生徒',exact:true})).toHaveAttribute('aria-current','page');
});

test('講師の空きコマから予定・科目の合う生徒を配置し、同じ保存処理とUndoを使う',async({page})=>{
  const state=await fixture(page,{setup:s=>{
    s.calendarTeachers.push({id:2,name:'別講師',name_kana:'べつこうし',active:true,subjects:[subject]});
  }});
  state.slowWrites=700;state.requests=[];
  await page.getByRole('button',{name:'講師から見る',exact:true}).click();
  await page.getByLabel('講師',{exact:true}).selectOption('2');
  const target=cell(page,term.dates[0]);
  await target.getByRole('button',{name:/空き・生徒を選ぶ/}).click();
  await expect(page.getByRole('button',{name:`生徒一・${subject}を配置`,exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'生徒二・中学英語を配置',exact:true})).toHaveCount(0);
  await page.getByLabel('配置する生徒を検索').fill('生徒二');
  await page.getByRole('button',{name:`生徒二・${subject}を配置`,exact:true}).click();
  await expect(target).toHaveClass(/pending/);
  await expect(target).toContainText('生徒二');
  await expect(target).toContainText('保存中');
  await expect(target).not.toHaveClass(/pending/);
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0].body).toMatchObject({student_id:2,teacher_id:2,subject,table_id:'auto',strict_availability:true,only_if_empty:true,expect:null});
  expect(state.requests.filter(r=>/candidates|used-tables|slot-summary|\/slots$/.test(r.path))).toHaveLength(0);
  await target.getByRole('button',{name:/生徒二/}).click();
  await page.getByRole('button',{name:'この生徒の時間割を開く'}).click();
  await expect(page.getByPlaceholder('生徒を検索')).toHaveValue('生徒二');
  await expect(target.locator('.pill')).toContainText('別講師');
  await page.getByRole('button',{name:'講師から見る',exact:true}).click();
  await expect(page.getByLabel('講師',{exact:true})).toHaveValue('2');
  await page.screenshot({path:test.info().outputPath('teacher-calendar.png'),fullPage:true});
  await page.getByRole('button',{name:'↶ 元に戻す'}).click();
  await expect(target.getByRole('button',{name:/空き・生徒を選ぶ/})).toBeVisible();
  await expect(page.locator('.assignment-save-status')).toContainText('保存済み');
  expect(state.assignments.map(a=>a.student_id)).toEqual([1]);
});

test('講師カレンダーでも保存失敗を取り消し、生徒の通塾予定で候補を絞る',async({page})=>{
  const state=await fixture(page,{setup:s=>{
    s.calendarStudentSlots={1:[],2:[`${term.dates[1]}#2`]};
    s.failPost=true;s.slowWrites=500;
  }});
  await page.getByRole('button',{name:'講師から見る',exact:true}).click();
  await cell(page,term.dates[2]).getByRole('button',{name:/空き・生徒を選ぶ/}).click();
  await expect(page.getByRole('dialog')).toContainText('生徒はいません');
  await page.keyboard.press('Escape');
  await cell(page,term.dates[1]).getByRole('button',{name:/空き・生徒を選ぶ/}).click();
  await expect(page.getByRole('button',{name:`生徒一・${subject}を配置`,exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:`生徒二・${subject}を配置`,exact:true}).click();
  await expect(cell(page,term.dates[1])).toHaveClass(/pending/);
  await expect(page.locator('.toast')).toContainText('一時的な保存エラー');
  await expect(cell(page,term.dates[1]).getByRole('button',{name:/空き・生徒を選ぶ/})).toBeVisible();
  await expect(page.getByRole('button',{name:'↶ 元に戻す'})).toBeDisabled();
  expect(state.assignments).toHaveLength(1);
});

test('講師カレンダーで別PCの授業を受け取り、古い詳細からは削除しない',async({page})=>{
  const state=await fixture(page);
  await page.getByRole('button',{name:'講師から見る',exact:true}).click();
  await cell(page,term.dates[0]).getByRole('button',{name:/生徒一/}).click();
  const replacement={...state.assignments[0],student_id:2,id:30};
  state.assignments=[replacement];
  state.events.push({id:++state.cursor,kind:'assignment_deleted',payload:{id:11}},{id:++state.cursor,kind:'assignment',payload:replacement});
  await expect(cell(page,term.dates[0])).toContainText('生徒二',{timeout:6000});
  await page.getByRole('button',{name:'この割り当てを削除',exact:true}).click();
  await expect(page.locator('.toast')).toContainText('授業が変更されています');
  expect(state.writes).toHaveLength(0);
  await cell(page,term.dates[0]).getByRole('button',{name:/生徒二/}).click();
  await page.getByRole('button',{name:'この割り当てを削除',exact:true}).click();
  await expect(cell(page,term.dates[0]).getByRole('button',{name:/空き・生徒を選ぶ/})).toBeVisible();
  await expect(page.locator('.assignment-save-status')).toContainText('保存済み');
  expect(state.writes.map(w=>w.method)).toEqual(['DELETE']);
});

test('講師の勤務外と満席には配置ボタンを出さず、スマホとダーク設定でも白い画面で使える',async({page})=>{
  await page.setViewportSize({width:320,height:844});
  await page.emulateMedia({colorScheme:'dark'});
  await fixture(page,{setup:s=>{
    s.calendarTeacherSlots={1:[`${term.dates[0]}#2`,`${term.dates[1]}#2`]};
    s.assignments.push({id:12,student_id:2,teacher_id:2,table_id:'A',subject,date:term.dates[1],period:2});
    s.tableIds=['A'];
  }});
  await page.getByRole('button',{name:'講師から見る',exact:true}).click();
  await expect(cell(page,term.dates[1]).getByRole('button',{name:/満席/})).toBeDisabled();
  await expect(cell(page,term.dates[2]).getByRole('button')).toHaveCount(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect(await page.locator('body').evaluate(n=>getComputedStyle(n).backgroundColor)).toBe('rgb(255, 255, 255)');
  await cell(page,term.dates[0]).getByRole('button',{name:/生徒一/}).click();
  const box=await page.getByRole('dialog').boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(320);
  await page.screenshot({path:test.info().outputPath('teacher-mobile.png'),fullPage:true});
});

test('comiruの入口を一つにし、対象を明示してこの生徒と全生徒を切り替える',async({page})=>{
  const state=await fixture(page);
  state.plan=[1,2].map(id=>({student_id:id,key:`${id}#2026-12-21#2`,op:'add',student_name:`生徒${id===1?'一':'二'}`,date:term.dates[0],period:2,teacher_name:'担当講師',comiru_subject:'数学'}));
  await expect(page.getByRole('button',{name:'comiru反映を確認',exact:true})).toHaveCount(1);
  await page.getByRole('button',{name:'comiru反映を確認',exact:true}).click();
  await expect(page.getByLabel('comiruに反映する対象')).toHaveValue('1');
  await expect(page.getByRole('button',{name:'反映する（1件）',exact:true})).toBeVisible();
  await page.getByLabel('comiruに反映する対象').selectOption('all');
  await expect(page.getByRole('button',{name:'反映する（2件）',exact:true})).toBeVisible();
  expect(state.requests.filter(r=>r.path.endsWith('/comiru/plan')).map(r=>r.search)).toEqual(['?student_id=1','']);
  expect(state.writes).toHaveLength(0);
});

test('comiru未設定でもコピペ用の退避が使え、元のGASの5列でコピーする',async({page})=>{
  await page.addInitScript(()=>{
    Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.copiedSheet=text;}}});
  });
  await fixture(page,{setup:s=>{s.comiruConfigured=false;}});
  await expect(page.locator('.comiru-actions')).toContainText('未設定');
  await page.getByText('コピペ用',{exact:true}).click();
  await page.getByRole('button',{name:'この生徒をコピー',exact:true}).click();
  expect(await page.evaluate(()=>window.copiedSheet)).toBe('生徒一\t担当講師\t数学\t2026/12/21\t2限（10:45-12:15）');
});

test('別PCの変更を受信済みなら、元に戻す操作でもその変更を上書きしない',async({page})=>{
  const state=await fixture(page);
  await page.locator('.teacher-chip').first().click();
  await cell(page,term.dates[1]).click();
  await expect(page.locator('.assignment-save-status')).toContainText('保存済み');
  const changed=state.assignments.find(a=>a.date===term.dates[1]);
  changed.subject='中学英語';
  state.events.push({id:++state.cursor,kind:'assignment',payload:{...changed}});
  await expect(cell(page,term.dates[1])).toContainText('中学英語',{timeout:6000});
  await page.getByRole('button',{name:'↶ 元に戻す'}).click();
  await expect(page.locator('.toast')).toContainText('この操作の後に授業が変更されています');
  expect(state.writes.map(w=>w.method)).toEqual(['POST']);
  await expect(cell(page,term.dates[1])).toContainText('中学英語');
});

test('初回配置・保存完了・生徒予定の不一致でもnullを出さず、表の位置と行の高さを変えない',async({page})=>{
  await page.setViewportSize({width:1280,height:1200});
  const state=await fixture(page);
  await page.getByPlaceholder('生徒を検索').fill('生徒二');
  await page.locator('.suggest-item').filter({hasText:'生徒二'}).click();
  const target=cell(page,term.dates[1]);
  const before=await target.boundingBox();
  const gridTop=await page.locator('.assign-grid').evaluate(n=>n.getBoundingClientRect().top+scrollY);
  state.slowWrites=600;
  await target.click();
  await page.locator('.teacher-item').first().click();
  await expect(target).toContainText('確認・保存中');
  const pending=await target.boundingBox();
  expect(pending.y).toBeCloseTo(before.y,0);expect(pending.height).toBeCloseTo(before.height,0);
  await expect(target).not.toHaveClass(/pending/);
  await expect(target).not.toContainText('null');
  const saved=await target.boundingBox();
  expect(saved.y).toBeCloseTo(before.y,0);expect(saved.height).toBeCloseTo(before.height,0);
  state.calendarStudentSlots={2:[]};
  state.events.push({id:++state.cursor,kind:'student',term_id:1,ref_id:2});
  await expect(target.locator('.acell-reason')).toContainText('生徒予定不一致',{timeout:6000});
  expect(await page.locator('.assign-grid').evaluate(n=>n.getBoundingClientRect().top+scrollY)).toBeCloseTo(gridTop,0);
  const conflict=await target.boundingBox();expect(conflict.height).toBeCloseTo(before.height,0);
  await expect(page.locator('#assign-root')).not.toContainText('null');
  await page.screenshot({path:test.info().outputPath('stable-calendar.png'),fullPage:true});
});

for(const [occupied,expected] of [[['A','B','C'],'D'],[['A','B','D'],'C']]) {
  test(`席${occupied.join('')}使用中なら${expected}を最初から選択する`,async({page})=>{
    const state=await fixture(page,{setup:s=>{
      s.tableIds=['A','B','C','D'];
      s.assignments.push(...occupied.map((table_id,i)=>({id:40+i,student_id:10+i,teacher_id:null,table_id,subject,date:term.dates[1],period:2})));
    }});
    await cell(page,term.dates[1]).click();
    await expect(page.getByRole('combobox',{name:'席',exact:true})).toHaveValue(expected);
    await expect(page.getByRole('dialog')).not.toContainText('自動選択');
    await expect(page.getByRole('combobox',{name:'席',exact:true}).locator('option:disabled')).toHaveCount(3);
    await page.locator('.teacher-item').first().click();
    await expect(cell(page,term.dates[1]).locator('.pill-table')).toHaveText(expected);
    expect(state.writes[0].body.table_id).toBe('auto');
  });
}

test('一週ずつ前後へ進み、登録と生徒・講師の切替で表示中の週を保つ',async({page})=>{
  await fixture(page);
  await expect(page.locator('.assign-table')).toHaveCount(1);
  await expect(page.getByRole('button',{name:'‹ 前の週',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'次の週 ›',exact:true}).click();
  await expect(page.getByLabel('表示する週')).toHaveValue('1');
  await expect(cell(page,term.dates[0])).toHaveCount(0);
  await cell(page,term.dates[7]).click();
  await page.locator('.teacher-item').first().click();
  await expect(page.locator('.assignment-save-status')).toContainText('保存済み');
  await expect(page.getByLabel('表示する週')).toHaveValue('1');
  await page.getByRole('button',{name:'講師から見る',exact:true}).click();
  await expect(page.getByLabel('表示する週')).toHaveValue('1');
  await expect(cell(page,term.dates[7])).toContainText('生徒一');
  await expect(page.getByRole('button',{name:'次の週 ›',exact:true})).toBeDisabled();
});

test('非表示の講師を見つけて詳細を開かず一覧に戻せる',async({page})=>{
  const state=await fixture(page,{setup:s=>{s.teachers=[{id:1,name:'非表示講師',hidden:true,linked:false,subjects:subject}];}});
  await page.getByRole('button',{name:'名簿・予定',exact:true}).click();
  await page.getByRole('button',{name:'非表示の講師を戻す',exact:true}).click();
  await expect(page.locator('table.list')).toContainText('非表示講師');
  await page.getByRole('button',{name:'一覧に戻す',exact:true}).click();
  await expect(page.locator('table.list')).not.toContainText('非表示講師');
  await page.getByRole('button',{name:'表示中の講師に戻る',exact:true}).click();
  await expect(page.locator('table.list')).toContainText('非表示講師');
  expect(state.teachers[0].hidden).toBe(false);
});

test('講師のログイン用メールを一か所で変更でき、解除の長い説明を出さない',async({page})=>{
  const state=await fixture(page,{setup:s=>{s.teachers=[{id:1,name:'担当講師',email:'old@example.invalid',google_email:'old@example.invalid',linked:true,hidden:false,subjects:subject}];}});
  await page.getByRole('button',{name:'名簿・予定',exact:true}).click();
  await page.getByRole('button',{name:'詳細',exact:true}).click();
  await expect(page.getByLabel('ログイン用メール',{exact:true})).toHaveValue('old@example.invalid');
  await expect(page.locator('.modal')).not.toContainText('自動で元に戻ります');
  await page.getByLabel('ログイン用メール',{exact:true}).fill('new@example.invalid');
  page.once('dialog',d=>d.accept());
  await page.getByRole('button',{name:'ログイン用メールを保存',exact:true}).click();
  await expect(page.locator('.toast')).toContainText('ログイン用メールを保存しました');
  expect(state.teachers[0].login_email_override).toBe('new@example.invalid');
  await page.getByRole('button',{name:'閉じる',exact:true}).click();
});

test('講師は名前の申請をせず登録したメールで利用できる',async({page})=>{
  const state=await fixture(page,{teacher:true,setup:s=>{s.teacherLinked=false;}});
  await expect(page.getByRole('button',{name:'申請する',exact:true})).toHaveCount(0);
  await expect(page.locator('.card')).toContainText('test@example.invalid');
  state.teacherLinked=true;
  await page.getByRole('button',{name:'登録を確認する',exact:true}).click();
  await expect(page.locator('.cal-cell.on').first()).toBeVisible();
});

test('設定の下から新規作成と削除を選べ、削除は確認・競合防止・復元ができる',async({page})=>{
  const state=await fixture(page);
  await page.getByRole('button',{name:'設定',exact:true}).click();
  await expect(page.locator('form .term-management')).toHaveCount(0);
  await expect(page.locator('.term-management').getByRole('button',{name:'＋ 新しい講習を作る'})).toBeVisible();
  await page.getByRole('button',{name:'この講習を削除',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'講習の削除確認'})).toContainText('comiruの授業は削除しません');
  await page.getByRole('button',{name:'キャンセル',exact:true}).click();
  expect(state.writes).toHaveLength(0);
  state.deleteFailure=true;
  await page.getByRole('button',{name:'この講習を削除',exact:true}).click();
  await page.getByRole('button',{name:'削除する',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('講習が変更されています');
  state.deleteFailure=false;
  await page.getByRole('button',{name:'削除する',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByText('削除した講習',{exact:true}).click();
  await page.getByRole('button',{name:'講習を戻す',exact:true}).click();
  await expect(page.getByLabel('講習名',{exact:true})).toHaveValue('冬期講習');
  expect(state.termDeleted).toBe(false);
});

test('事務が講師の予定を代わりに直し、理由と変更が履歴に出る。先に保存されていたら上書きしない',async({page})=>{
  const state=await fixture(page);
  state.teachers=[{id:1,name:'担当講師',name_kana:'たんとうこうし',subjects:subject,linked:true,hidden:false,submitted_at:'2026-11-03T09:00:00Z',slot_count:70}];
  state.history=[{id:1,actor_role:'teacher',actor_email:'t@example.invalid',added:slots.slice(0,3),removed:[],note_before:null,note_after:null,reason:'',created_at:'2026-11-03T09:00:00Z'}];
  await page.getByRole('button',{name:'名簿・予定',exact:true}).click();
  await page.getByRole('button',{name:'講師',exact:true}).click();
  await page.getByRole('button',{name:'詳細',exact:true}).click();
  const modal=page.locator('.modal');
  await expect(modal.locator('.history summary')).toContainText('変更履歴（1件）');
  await modal.getByRole('button',{name:'予定を代わりに直す',exact:true}).click();
  await modal.locator('.cal-cell.editable[data-key="2026-12-21#2"]').click();
  await expect(modal.getByText('69コマ（＋0・−1）')).toBeVisible();
  await modal.getByLabel('理由・連絡の手段（履歴に残ります）').fill('電話で連絡');
  // 閉じようとすると、直した内容を捨ててよいか確認する（キャンセル）
  page.once('dialog',d=>d.dismiss());
  await modal.getByRole('button',{name:'閉じる',exact:true}).click();
  await expect(modal).toHaveCount(1);
  await modal.getByRole('button',{name:'代わりに保存',exact:true}).click();
  await expect(page.locator('.toast')).toContainText('代わりに保存しました');
  expect(state.proxyWrites[0]).toMatchObject({reason:'電話で連絡',expected_rev:3});
  expect(state.proxyWrites[0].slots).toHaveLength(69);
  await expect(modal.locator('.history summary')).toContainText('事務の代理入力あり');
  await modal.locator('.history summary').click();
  await expect(modal.locator('.history-list li').first()).toContainText('理由：電話で連絡');
  await expect(modal.locator('.history-list li').first()).toContainText('来られなくなった');
  // 2回目：ほかの人が先に保存していたら 409。読み込み直さなければ、直した内容を残す
  state.proxyStale=true;
  await modal.getByRole('button',{name:'予定を代わりに直す',exact:true}).click();
  await modal.locator('.cal-cell.editable[data-key="2026-12-22#2"]').click();
  page.once('dialog',d=>{expect(d.message()).toContain('先にこの講師の予定を保存');d.dismiss();});
  await modal.getByRole('button',{name:'代わりに保存',exact:true}).click();
  await expect(modal.getByText('68コマ（＋0・−1）')).toBeVisible();
  expect(state.proxyWrites[1].expected_rev).toBe(4);
});


async function grab(page, locator) {
  const a=await locator.boundingBox();
  await page.mouse.move(a.x+a.width/2,a.y+a.height/2);
  await page.mouse.down();
  await page.mouse.move(a.x+a.width/2+20,a.y+a.height/2+20,{steps:3});
}
async function moveTo(page, locator) {
  const b=await locator.boundingBox();
  await page.mouse.move(b.x+b.width/2,b.y+b.height/2,{steps:5});
}

test('授業をドラッグして画面下のゴミ箱に落とすと消え、元に戻せる。×はいつも見えている',async({page})=>{
  const state=await fixture(page);
  const source=cell(page,term.dates[0]);
  await expect(source.locator('.acell-del')).toBeVisible();
  const box=await source.locator('.acell-del').boundingBox();
  expect(box.width).toBeGreaterThanOrEqual(22);
  await grab(page,source.locator('.pill'));
  const trash=page.locator('.drag-trash');
  await expect(trash).toBeVisible();
  await moveTo(page,trash);
  await expect(trash).toHaveClass(/over/);
  await page.mouse.up();
  await expect(trash).toHaveCount(0);
  await expect(source.locator('.pill')).toHaveCount(0);
  await expect.poll(()=>state.writes.filter(w=>w.method==='DELETE').length).toBe(1);
  await page.getByRole('button',{name:'↶ 元に戻す'}).click();
  await expect(source.locator('.pill')).toHaveCount(1);
});

test('ドラッグ中に「次の週」の上で止めると週が変わり、ほかの週のコマへ移せる',async({page})=>{
  const state=await fixture(page);
  await expect(page.getByLabel('表示する週')).toHaveValue('0');
  await grab(page,cell(page,term.dates[0]).locator('.pill'));
  await moveTo(page,page.getByRole('button',{name:'次の週 ›',exact:true}));
  await expect(page.getByLabel('表示する週')).toHaveValue('1');
  await moveTo(page,cell(page,term.dates[8]));
  await page.mouse.up();
  await expect(cell(page,term.dates[8]).locator('.pill')).toContainText('担当講師');
  await expect.poll(()=>state.writes.filter(w=>w.method==='PATCH').map(w=>w.body.date)).toEqual([term.dates[8]]);
  await page.getByRole('button',{name:'‹ 前の週',exact:true}).click();
  await expect(cell(page,term.dates[0]).locator('.pill')).toHaveCount(0);
});

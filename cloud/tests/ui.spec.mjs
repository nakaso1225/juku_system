import { test, expect } from '@playwright/test';

const subject = '中学数学';
const term = {
  id: 1, name: '冬期講習', start_date: '2026-12-21', end_date: '2027-01-03',
  dates: Array.from({length:14}, (_,i)=>new Date(Date.UTC(2026,11,21+i)).toISOString().slice(0,10)),
  periods: [2,3,4,5,6], closed_dates: [], accepting: true,
  period_times: {2:{start:'10:00',end:'11:00'},3:{start:'11:10',end:'12:10'}},
};
const slots = term.dates.flatMap(date=>term.periods.map(period=>({date,period})));

async function fixture(page, { teacher = false } = {}) {
  const state = {
    assignments: [{id:11,student_id:1,teacher_id:1,teacher_name:'担当講師',table_id:'A',subject,date:term.dates[0],period:2}],
    note: '', version: 1, cursor: 1, events: [], writes: [], slowReads: 0, slowWrites: 0, failReads: false, failPatch: false, plan: [], failComiru: false, failPost: false, failTermsReload: false, termReads: 0, boardDelays: {}, tableIds: ['A','B'], failSettings: false, requests: [], studentProfile: {}, teachers: [], failSlots: false, failAvailability: false,
  };
  const students = () => [1,2].map(id=>({id,name:id===1?'生徒一':'生徒二',...(id===1?state.studentProfile:{}),subjects:[subject,'中学英語'],status:'調整中',display_status:'調整中',has_error:false,assignment_count:state.assignments.filter(a=>a.student_id===id).length,entered:true}));
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const method = request.method();
    state.requests.push({path,method});
    const body = ['POST','PUT','PATCH'].includes(method) ? request.postDataJSON() : null;
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
    if(path==='/api/me') return send({user:{email:'test@example.invalid'},is_staff:true,teacher:teacher?{id:1}:null});
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
      return send([term,{...term,id:2,name:'春期講習'}]);
    }
    if(/^\/api\/admin\/terms\/\d+$/.test(path) && write) return send({...term,...body});
    if(path.endsWith('/version')) return send({version:state.version,term});
    const keys = slots.map(s=>`${s.date}#${s.period}`);
    const snapStudents = () => students().map(s=>({...s,name_kana:s.name_kana??'',grade:s.grade??'',note:s.id===1?state.note:'',entered:true}));
    if(path.endsWith('/assign/snapshot')) return send({cursor:state.cursor,version:state.version,term,table_ids:state.tableIds,
      teachers:[{id:1,name:'担当講師',name_kana:'',subjects:[subject,'中学英語']}],teacher_slots:{1:keys},
      students:snapStudents(),student_slots:{1:keys,2:keys},
      assignments:state.assignments.map(({id,student_id,teacher_id,table_id,subject,date,period})=>({id,student_id,teacher_id,table_id,subject,date,period}))});
    if(path.endsWith('/assign/changes')) {
      const since=Number(new URL(request.url()).searchParams.get('since'));
      return send({reload:false,cursor:state.cursor,events:state.events.filter(e=>e.id>since)});
    }
    if(/\/assign\/students\/\d+\/info$/.test(path)) {const id=Number(path.split('/').at(-2));return send({student:snapStudents().find(s=>s.id===id),slots:keys});}
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
    if(path.endsWith('/comiru/plan')) return send({items:state.plan,verified:true});
    if(path.endsWith('/comiru/apply')) return state.failComiru ? send({error:'通信エラー'},503) : send({results:body.keys.map(key=>({key,ok:true,message:'登録しました'}))});
    if(path==='/api/admin/comiru/status') return send({configured:false});
    if(path.endsWith('/comiru/status')) return send({configured:true,pending_total:state.assignments.length,students:{1:{pending:state.assignments.length,registered:0}}});
    if(path.endsWith('/assign/used-tables')) return send({used_table_ids:[]});
    if(path.endsWith('/assign/candidates')) return send([{teacher_id:1,name:'担当講師',assignment_count:1,has_conflict:false}]);
    if(/\/assign\/teachers\/\d+\/slots$/.test(path)) return state.failSlots ? send({error:'予定取得が遅れています'},503) : send({availability:slots,busy:[]});
    if(path.endsWith('/assignments') && method==='POST') {
      if(state.failPost) return send({error:'一時的な保存エラー'},503);
      state.version++;
      const a={...body,table_id:body.table_id==='auto'?'A':body.table_id,id:22,teacher_name:'担当講師',version:state.version};
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
    if(path==='/api/admin/teachers')return send(state.teachers);
    if(path==='/api/admin/link-requests')return send([]);
    if(/\/teachers\/\d+\/profile$/.test(path)){state.teachers[0].name_kana=body.name_kana;return send({ok:true});}
    if(/\/teachers\/\d+$/.test(path))return send({term,slots,note:'',updated_at:'2026-11-03T09:00:00Z'});
    throw new Error(`Unhandled fixture: ${method} ${path}`);
  });
  await page.goto(teacher?'/':'/admin.html');
  await expect(page.getByRole('heading',{name:teacher?'講習の予定入力':'講習管理',exact:true})).toBeVisible();
  await expect(page.locator(teacher?'.cal-cell.on':'.pill').first()).toBeVisible();
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
  await page.getByRole('button',{name:'講習の設定',exact:true}).click();
  await page.getByLabel('講習名', {exact:true}).fill('変更中');
  page.once('dialog',d=>d.dismiss());
  await page.getByRole('button',{name:'割り当て',exact:true}).click();
  await expect(page.getByLabel('講習名',{exact:true})).toHaveValue('変更中');
  page.once('dialog',d=>d.dismiss());
  await page.locator('select').first().selectOption('2');
  await expect(page.locator('select').first()).toHaveValue('1');
  await expect(page.getByLabel('講習名',{exact:true})).toHaveValue('変更中');
  page.once('dialog',d=>d.accept());
  await page.getByRole('button',{name:'割り当て',exact:true}).click();
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
  const del=cell(page,term.dates[0]).getByRole('button',{name:'×',exact:true});
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
  await page.getByRole('button',{name:/この生徒を comiru に反映/}).click();
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
  await page.getByRole('button',{name:'座席設定',exact:true}).click();
  await page.getByLabel('座席数',{exact:true}).fill('27');
  await expect(page.locator('.seat-preview .badge')).toHaveCount(27);
  await expect(page.locator('.seat-preview')).toContainText('AA');
  await page.getByRole('button',{name:'座席設定を保存'}).click();
  await expect(page.getByRole('status')).toContainText('保存済み：27席');
  expect(state.tableIds.at(-1)).toBe('AA');
  await page.screenshot({path:test.info().outputPath('settings.png'),fullPage:true});
  await page.getByRole('button',{name:'割り当て',exact:true}).click();
  await cell(page,term.dates[1]).click();
  await expect(page.locator('.popover select option[value="AA"]')).toHaveCount(1);
  await page.screenshot({path:test.info().outputPath('seat-options.png'),fullPage:true});
});

test('使用中の席を減らす操作が拒否されたら、設定を保存済みにしない',async({page})=>{
  const state=await fixture(page);state.failSettings=true;
  await page.getByRole('button',{name:'座席設定',exact:true}).click();
  await page.getByLabel('座席数',{exact:true}).fill('1');
  await page.getByRole('button',{name:'座席設定を保存'}).click();
  await expect(page.locator('.toast')).toContainText('席Bに授業');
  await expect(page.getByRole('status')).toContainText('未保存');
  expect(state.tableIds).toEqual(['A','B']);
  page.once('dialog',d=>d.dismiss());
  await page.getByRole('button',{name:'割り当て',exact:true}).click();
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

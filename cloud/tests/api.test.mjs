import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = join(root, 'node_modules/wrangler/bin/wrangler.js');
let work, server, mock, origin, cookie, config;
let log = '';
// テストの途中で comiru の名簿を差し替えるため（null なら下の既定の名簿）
const roster = { teachers: null, students: null };
const teachers = [
  { id: 101, name: '山田先生', name_kana: 'やまだ', email: 'api-test@example.invalid' },
  { id: 102, name: '佐藤先生', name_kana: 'さとう', email: 'sato@example.invalid' },
  { id: 103, name: '青木先生', name_kana: 'あおき', email: 'aoki@example.invalid' },
];
const students = [
  { id: 201, name: '高校生', name_kana: 'こうこうせい', grade_name: '高校1年生' },
  { id: 202, name: '中学生', name_kana: 'ちゅうがくせい', grade: { name: '中学2年生' } },
  { id: 203, name: '小学生二', name_kana: 'しょうがくせいに', grade_name: '小学2年生' },
  { id: 204, name: '小学生一', name_kana: 'しょうがくせいいち', grade_name: '小1' },
];
async function listen(http) {
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  return http.address().port;
}
async function command(args) {
  const child = spawn(process.execPath, [cli, ...args], { cwd: root, env: { ...process.env, CI: 'true' } });
  let output = '';
  child.stdout.on('data', x => { output += x; });
  child.stderr.on('data', x => { output += x; });
  const code = await new Promise(resolve => child.on('exit', resolve));
  assert.equal(code, 0, output);
}
async function api(path, { method = 'GET', body, status = 200 } = {}) {
  const response = await fetch(origin + '/api' + path, {
    method, headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  assert.equal(response.status, status, JSON.stringify(result));
  return result;
}
const base = '/admin/terms/1';
const slot = (student_id, date = '2026-12-21') => ({ student_id, teacher_id: 1, table_id: 'auto', subject: '中学数学', date, period: 2 });

before(async () => {
  work = await mkdtemp(join(tmpdir(), 'juku-api-'));
  mock = createServer((req, res) => {
    const list = req.url.includes('/teachers') ? roster.teachers ?? teachers : roster.students ?? students;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: list, last_page: 1 }));
  });
  const mockPort = await listen(mock);
  config = join(work, 'wrangler.json');
  await writeFile(config, JSON.stringify({
    name: 'juku-api-test', main: join(root, 'src/index.ts'), compatibility_date: '2026-05-01',
    vars: { DEV_LOGIN: '1', ADMIN_EMAILS: 'api-test@example.invalid', SESSION_SECRET: 'isolated-api-test-secret',
      COMIRU_TOKEN: 'test-only', COMIRU_SCHOOL_ID: '1', COMIRU_API_BASE_URL: `http://127.0.0.1:${mockPort}` },
    d1_databases: [{ binding: 'DB', database_name: 'juku-api-test', database_id: '00000000-0000-0000-0000-000000000000', migrations_dir: join(root, 'migrations') }],
  }));
  const d1 = ['--config', config, '--local', '--persist-to', join(work, 'state')];
  await command(['d1', 'migrations', 'apply', 'juku-api-test', ...d1]);
  const seed = join(work, 'seed.sql');
  await writeFile(seed, `
    INSERT INTO terms(id,name,start_date,end_date,periods,closed_dates) VALUES(1,'試験講習','2026-12-21','2026-12-28','[2,3]','[]');
    INSERT INTO teachers(id,name,email,status,comiru_teacher_id) VALUES
      (1,'山田先生','api-test@example.invalid','approved',101),(2,'佐藤先生','sato@example.invalid','approved',102),(3,'青木先生','aoki@example.invalid','approved',103);
    INSERT INTO students(id,name,comiru_student_id) VALUES(1,'高校生',201),(2,'中学生',202),(3,'小学生二',203),(4,'小学生一',204);
    INSERT INTO teacher_subjects VALUES(1,'中学数学'),(2,'中学数学'),(3,'中学数学');
    INSERT INTO teacher_availability VALUES(1,1,'2026-12-21',2),(1,2,'2026-12-21',2),(1,3,'2026-12-21',2),(1,1,'2026-12-22',2),(1,1,'2026-12-23',2);
    INSERT INTO student_term_entries(term_id,student_id,subjects,note,created_at,updated_at)
      SELECT 1,id,'["中学数学"]','','2026-11-03','2026-11-03' FROM students;
    INSERT INTO student_availability(term_id,student_id,date,period)
      SELECT 1,id,'2026-12-21',2 FROM students;
    INSERT INTO student_availability VALUES(1,4,'2026-12-22',2);
  `);
  await command(['d1', 'execute', 'juku-api-test', ...d1, '--file', seed]);
  const probe = createServer();
  const port = await listen(probe);
  await new Promise(resolve => probe.close(resolve));
  origin = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [cli, 'dev', ...d1, '--ip', '127.0.0.1', '--port', String(port)], { cwd: root });
  server.stdout.on('data', x => { log = (log + x).slice(-10000); });
  server.stderr.on('data', x => { log = (log + x).slice(-10000); });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { ready = (await fetch(origin + '/api/me')).status === 401; } catch {}
    if (ready) break;
    await delay(200);
  }
  assert.ok(ready, log);
  const login = await fetch(origin + '/auth/dev-login?email=api-test%40example.invalid', { redirect: 'manual' });
  assert.equal(login.status, 302);
  cookie = login.headers.get('set-cookie').split(';')[0];
}, { timeout: 45000 });

after(async () => {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([new Promise(resolve => server.on('exit', resolve)), delay(3000)]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  if (mock) await new Promise(resolve => mock.close(resolve));
  if (work) await rm(work, { recursive: true, force: true });
});

test('名簿の読み仮名・学年を取り込み、一覧と候補を指定順に並べる', async () => {
  const teacherList = await api('/admin/teachers?term_id=1');
  assert.deepEqual(teacherList.map(t => t.id), [3,2,1]);
  const studentList = await api(base + '/students');
  assert.deepEqual(studentList.map(s => s.grade), ['小1','小2','中2','高1']);
  const assignList = await api(base + '/assign/students');
  assert.deepEqual(assignList.map(s => s.id), [4,3,2,1]);
  const candidates = await api(base + '/assign/candidates?date=2026-12-21&period=2&subject=' + encodeURIComponent('中学数学') + '&student_id=1');
  assert.deepEqual(candidates.map(t => t.teacher_id), [3,2,1]);
});

test('座席をAA以降まで増やせて、不正な座席数を拒否する', async () => {
  const expanded = await api('/admin/settings', { method: 'PUT', body: { table_count: 28 } });
  assert.deepEqual(expanded.table_ids.slice(-3), ['Z','AA','AB']);
  assert.equal((await api('/meta')).table_ids.length, 28);
  assert.equal((await api(base + '/version')).table_ids.length, 28);
  await api('/admin/settings', { method: 'PUT', body: { table_count: 0 }, status: 400 });
  await api('/admin/settings', { method: 'PUT', body: { table_count: 101 }, status: 400 });
  await api('/admin/settings', { method: 'PUT', body: { table_count: 2 } });
});

test('同時登録でも空席を別々に選び、満席なら保存せずエラーを返す', async () => {
  const [a,b] = await Promise.all([
    api(base + '/assignments', { method: 'POST', body: slot(1), status: 201 }),
    api(base + '/assignments', { method: 'POST', body: slot(2), status: 201 }),
  ]);
  assert.deepEqual(new Set([a.table_id,b.table_id]), new Set(['A','B']));
  assert.ok(a.id && b.id && a.version && b.version);
  assert.equal(a.has_table_conflict, false);assert.equal(b.has_table_conflict, false);
  const version = (await api(base + '/version')).version;
  await api(base + '/assignments', { method: 'POST', body: slot(3), status: 409 });
  assert.equal((await api(base + '/version')).version, version);
  assert.equal((await api(base + '/assign/students/3')).assignments.length, 0);
});

test('使用中の座席を減らせず、設定も元のまま残す', async () => {
  await api('/admin/settings', { method: 'PUT', body: { table_count: 1 }, status: 409 });
  assert.equal((await api('/admin/settings')).table_ids.length, 2);
});

test('対象外日時・無効な講師・無効な席は保存せず、移動失敗でも元を残す', async () => {
  await api(base + '/assignments', { method: 'POST', body: { ...slot(3), date: '2027-01-01' }, status: 400 });
  await api(base + '/assignments', { method: 'POST', body: { ...slot(3), teacher_id: 999 }, status: 404 });
  await api(base + '/assignments', { method: 'POST', body: { ...slot(3), table_id: 'ZZ' }, status: 400 });
  const original = (await api(base + '/assign/students/1')).assignments[0];
  const second = await api(base + '/assignments', { method: 'POST', body: slot(1,'2026-12-22'), status: 201 });
  await api(base + `/assignments/${original.id}`, { method: 'PATCH', body: slot(1,'2026-12-22'), status: 409 });
  assert.equal((await api(base + '/assign/students/1')).assignments.length, 2);
  const moved = await api(base + `/assignments/${second.id}`, { method: 'PATCH', body: slot(1,'2026-12-23') });
  assert.equal(moved.id, second.id);assert.equal(moved.date,'2026-12-23');assert.equal(moved.table_id,'A');
});

test('手入力したふりがな・学年は名簿を取り直しても維持する', async () => {
  await api('/admin/teachers/1/profile', { method: 'PATCH', body: { name_kana: 'あいうえお' } });
  await api(base + '/students/1', { method: 'PUT', body: { subjects:['中学数学'],slots:[],note:'',name_kana:'あおい',grade:'小1' } });
  await api('/admin/comiru/refresh?which=teachers', { method:'POST' });
  await api('/admin/comiru/refresh?which=students', { method:'POST' });
  assert.equal((await api('/admin/teachers?term_id=1'))[0].id,1);
  const student = (await api(base + '/students')).find(s=>s.id===1);
  assert.equal(student.name_kana,'あおい');assert.equal(student.grade,'小1');
});


test('ドラッグ保存では生徒と講師の予定・担当科目をDBで確認し、不一致なら保存しない',async()=>{
  await api('/admin/settings',{method:'PUT',body:{table_count:4}});
  const version=(await api(base+'/version')).version;
  const studentError=await api(base+'/assignments',{method:'POST',body:{...slot(3,'2026-12-23'),strict_availability:true},status:409});
  assert.match(studentError.error,/生徒が来られない/);
  const teacherError=await api(base+'/assignments',{method:'POST',body:{...slot(3),subject:'中学英語',strict_availability:true},status:409});
  assert.match(teacherError.error,/講師がこの日時に来られないか/);
  assert.equal((await api(base+'/version')).version,version);
  assert.equal((await api(base+'/assign/students/3')).assignments.length,0);
  const saved=await api(base+'/assignments',{method:'POST',body:{...slot(3),teacher_id:2,strict_availability:true,only_if_empty:true},status:201});
  assert.equal(saved.has_schedule_mismatch,false);
  assert.equal(saved.has_student_schedule_mismatch,false);
});

test('講師予定の合わない移動を拒否し、元の日時・講師を維持する',async()=>{
  const saved=await api(base+'/assignments',{method:'POST',body:{...slot(4),teacher_id:3,strict_availability:true,only_if_empty:true},status:201});
  const error=await api(base+`/assignments/${saved.id}`,{method:'PATCH',body:{...slot(4,'2026-12-22'),teacher_id:3,strict_availability:true},status:409});
  assert.match(error.error,/講師がこの日時に来られないか/);
  const original=(await api(base+'/assign/students/4')).assignments[0];
  assert.equal(original.id,saved.id);assert.equal(original.date,saved.date);assert.equal(original.teacher_id,3);
});

test('画面に出ていない授業が先に登録されていた場合、ドラッグで上書きしない',async()=>{
  const error=await api(base+'/assignments',{method:'POST',body:{...slot(3),strict_availability:true,only_if_empty:true},status:409});
  assert.match(error.error,/すでに授業が登録されています/);
  assert.equal((await api(base+'/assign/students/3')).assignments[0].teacher_id,2);
});

// ---------------------------------------------------------------- 監査で見つかった問題が直っていることの確認

test('comiru の数値の学年コードを変換し、退会した生徒は名簿から外す', async () => {
  const code = { 201: 13, 202: 11, 203: 5, 204: 4 };
  roster.students = [
    ...students.map((s) => ({ ...s, grade_name: undefined, grade: code[s.id], is_deleted: false })),
    { id: 205, name: '新小学生', name_kana: 'しんしょうがくせい', grade: 4, is_deleted: false },
    { id: 206, name: '退会済み新規', name_kana: 'たいかいずみ', grade: 4, is_deleted: true },
    { id: 207, name: '退会日あり', name_kana: 'たいかいびあり', grade: 10, out_school_date: '2020-01-01' },
    { id: 208, name: '大学生', name_kana: 'だいがくせい', grade: 50 },
  ];
  try {
    await api('/admin/comiru/refresh?which=students', { method: 'POST' });
    const list = await api(base + '/students');
    assert.equal(list.find((s) => s.comiru_student_id === 205).grade, '小1');
    assert.equal(list.find((s) => s.id === 2).grade, '中2');
    assert.equal(list.find((s) => s.comiru_student_id === 208).grade, 'その他');
    assert.equal(list.some((s) => s.comiru_student_id === 206), false);
    assert.equal(list.some((s) => s.comiru_student_id === 207), false);
  } finally {
    roster.students = null;
    await api('/admin/comiru/refresh?which=students', { method: 'POST' });
  }
});

test('comiru の講師名簿から外れた講師は、ログイン済みでも予定を見たり保存したりできない', async () => {
  assert.equal((await api('/teacher/profile')).teacher.id, 1);
  roster.teachers = teachers.filter((t) => t.id !== 101);
  try {
    await api('/admin/comiru/refresh?which=teachers', { method: 'POST' });
    assert.equal((await api('/teacher/profile')).teacher, null);
    assert.equal((await api('/me')).teacher_inactive, true);
    const error = await api('/teacher/terms/1', { method: 'PUT', body: { slots: [], note: '' }, status: 403 });
    assert.match(error.error, /講師名簿にいない/);
    const candidates = await api(base + '/assign/candidates?date=2026-12-21&period=2&subject=' + encodeURIComponent('中学数学') + '&student_id=1');
    assert.equal(candidates.some((t) => t.teacher_id === 1), false);
  } finally {
    roster.teachers = null;
    await api('/admin/comiru/refresh?which=teachers', { method: 'POST' });
  }
  assert.equal((await api('/teacher/profile')).teacher.id, 1);
});

test('完了の生徒にエラーが出たら調整中に戻し、直しても自動では完了に戻さない', async () => {
  const availability = [{ date: '2026-12-21', period: 2 }, { date: '2026-12-22', period: 2 }];
  await api(base + '/students/4', { method: 'PUT', body: { subjects: ['中学数学'], slots: availability, note: '' } });
  await api(base + '/assign/students/4/status', { method: 'PATCH', body: { status: '完了' } });
  await api(base + '/students/4', { method: 'PUT', body: { subjects: ['中学数学'], slots: [], note: '' } });
  let board = await api(base + '/assign/students/4');
  assert.equal(board.student.display_status, '要調整');
  assert.equal(board.student.status, '調整中');
  await api(base + '/students/4', { method: 'PUT', body: { subjects: ['中学数学'], slots: availability, note: '' } });
  board = await api(base + '/assign/students/4');
  assert.equal(board.student.display_status, '調整中');
});

test('休校日に変える日の授業は、確認してから保存し、消さずに「休校日・期間外」のエラーとして残す', async () => {
  const term = (await api('/admin/terms'))[0];
  const refused = await api(base, { method: 'PUT', body: { ...term, closed_dates: ['2026-12-21'] }, status: 409 });
  assert.ok(refused.affected.length > 0);
  assert.equal((await api('/admin/terms'))[0].closed_dates.length, 0); // 確認するまで保存しない
  await api(base, { method: 'PUT', body: { ...term, closed_dates: ['2026-12-21'], confirm_affected: true } });
  const board = await api(base + '/assign/students/3');
  const a = board.assignments.find((x) => x.date === '2026-12-21');
  assert.equal(a.has_slot_invalid, true);
  assert.equal(a.has_conflict, true);
  // 休校日になった日を含む予定も、そのまま保存し直せる（その日の分は外れる）
  const entry = await api(base + '/students/3');
  const saved = await api(base + '/students/3', { method: 'PUT', body: { subjects: entry.subjects, slots: entry.slots, note: entry.note } });
  assert.equal(saved.slot_count, entry.slots.filter((x) => x.date !== '2026-12-21').length);
  await api(base, { method: 'PUT', body: { ...term, closed_dates: [] } });
  await api(base + '/students/3', { method: 'PUT', body: { subjects: entry.subjects, slots: entry.slots, note: entry.note } });
});

test('古い画面からの削除・上書きは、ほかの人の変更ごと消さずに 409 で止める', async () => {
  const original = (await api(base + '/assign/students/4')).assignments[0];
  const seen = { teacher_id: original.teacher_id, table_id: original.table_id, subject: original.subject, date: original.date, period: original.period };
  // 別の担当者が講師を変えた
  await api(base + `/assignments/${original.id}`, { method: 'PATCH', body: { ...slot(4), teacher_id: 2, table_id: original.table_id } });
  // 古い画面（変更前の講師を見ている）からの削除・移動・上書きは止める
  await api(base + `/assignments/${original.id}`, { method: 'DELETE', body: { expect: seen }, status: 409 });
  await api(base + `/assignments/${original.id}`, { method: 'PATCH', body: { ...slot(4, '2026-12-22'), teacher_id: 3, expect: seen }, status: 409 });
  await api(base + '/assignments', { method: 'POST', body: { ...slot(4), teacher_id: 3, expect: seen }, status: 409 });
  await api(base + '/assignments', { method: 'POST', body: { ...slot(4), teacher_id: 3, expect: null }, status: 409 }); // 空いているはず、も違う
  const now = (await api(base + '/assign/students/4')).assignments[0];
  assert.equal(now.id, original.id);assert.equal(now.teacher_id, 2);
  // 今の内容を見ていれば消せる
  await api(base + `/assignments/${original.id}`, { method: 'DELETE', body: { expect: { ...seen, teacher_id: 2 } } });
  assert.equal((await api(base + '/assign/students/4')).assignments.length, 0);
});

test('生徒の予定を2人が同時に直したら、あとの保存を 409 で止めて先の変更を守る', async () => {
  const entry = await api(base + '/students/3');
  const body = { subjects: entry.subjects, slots: entry.slots };
  const first = await api(base + '/students/3', { method: 'PUT', body: { ...body, note: '担当A', expected_rev: entry.rev } });
  assert.equal(first.rev, entry.rev + 1);
  const error = await api(base + '/students/3', { method: 'PUT', body: { ...body, note: '担当B（古い画面）', expected_rev: entry.rev }, status: 409 });
  assert.match(error.error, /ほかの人が先に/);
  assert.equal((await api(base + '/students/3')).note, '担当A');
  await api(base + '/students/3', { method: 'PUT', body: { ...body, note: '担当B（開き直した）', expected_rev: first.rev } });
});


// comiru への反映のテスト（ローカルの Worker と、comiru 公式仕様に合わせた偽の comiru を使う。本物の comiru には接続しない）
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = join(root, 'node_modules/wrangler/bin/wrangler.js');
let work, server, mockServer, origin, cookie;
let log = '';

const teachers = [
  { id: 101, name: '山田先生', name_kana: 'やまだ', email: 'api-test@example.invalid' },
  { id: 102, name: '佐藤先生', name_kana: 'さとう', email: 'sato@example.invalid' },
];
const students = [
  { id: 201, name: '高校生', name_kana: 'こうこうせい', grade: 13 },
  { id: 202, name: '中学生', name_kana: 'ちゅうがくせい', grade: 11 },
  { id: 203, name: '小学生', name_kana: 'しょうがくせい', grade: 5 },
];
const comas = [{ id: 2, coma_no: 2, time_start: '10:45', time_end: '12:15' }, { id: 3, coma_no: 3, time_start: '13:15', time_end: '14:45' }];

// 偽の comiru（GET/POST/PUT/DELETE seats。一覧は期間・生徒で絞り、ページ分けする）
const comiru = { seats: [], nextId: 5000, calls: [], failPost: false, failPut: false, pageSize: 500 };
const nameOf = (list, id) => list.find((x) => x.id === id)?.name ?? '';
function view(seat) {
  const coma = comas.find((c) => c.id === seat.coma_id);
  return {
    id: seat.id, date: seat.date, start_time: coma.time_start, end_time: coma.time_end, classroom: seat.classroom,
    teacher: { id: seat.teacher_id, name: nameOf(teachers, seat.teacher_id) },
    seat_students: seat.students.map((s) => ({ student_id: s.student_id, student_name: nameOf(students, s.student_id), subject: s.subject, absent: Boolean(s.absent) })),
  };
}
function classroomTaken(date, comaId, classroom, exceptId) {
  return comiru.seats.some((s) => s.id !== exceptId && s.date === date && s.coma_id === comaId && s.classroom === classroom);
}
async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : null;
}

async function listen(http) {
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  return http.address().port;
}
async function command(args) {
  const child = spawn(process.execPath, [cli, ...args], { cwd: root, env: { ...process.env, CI: 'true' } });
  let output = '';
  child.stdout.on('data', (x) => { output += x; });
  child.stderr.on('data', (x) => { output += x; });
  const code = await new Promise((resolve) => child.on('exit', resolve));
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
const assign = (student_id, date, extra = {}) =>
  api(base + '/assignments', { method: 'POST', body: { student_id, teacher_id: 1, table_id: 'auto', subject: '中学数学', date, period: 2, ...extra }, status: 201 });
const plan = async (studentId) => (await api(base + `/comiru/plan?student_id=${studentId}`)).items;
const apply = async (keys) => (await api(base + '/comiru/apply', { method: 'POST', body: { keys } })).results;
const calls = (method) => comiru.calls.filter((c) => c.method === method);

before(async () => {
  work = await mkdtemp(join(tmpdir(), 'juku-comiru-'));
  mockServer = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (body, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    const path = url.pathname.replace(/^\/1\//, '');
    if (req.method !== 'GET') comiru.calls.push({ method: req.method, path });
    if (path === 'teachers') return send({ data: teachers, last_page: 1 });
    if (path === 'students') return send({ data: students, last_page: 1 });
    if (path === 'comas') return send({ data: comas });
    if (path === 'subjects') return send({ data: ['数学', '英語'] });
    if (path === 'seats' && req.method === 'GET') {
      const start = url.searchParams.get('start_date'), end = url.searchParams.get('end_date');
      const sid = url.searchParams.get('student_id');
      const perPage = Math.min(Number(url.searchParams.get('per_page') ?? 500), comiru.pageSize);
      const page = Number(url.searchParams.get('page') ?? 1);
      const list = comiru.seats
        .filter((s) => s.date >= start && s.date <= end && (!sid || s.students.some((x) => x.student_id === Number(sid))))
        .sort((a, b) => a.id - b.id)
        .slice((page - 1) * perPage, page * perPage);
      const byDate = new Map();
      for (const s of list) byDate.set(s.date, [...(byDate.get(s.date) ?? []), view(s)]);
      return send({ data: [...byDate.entries()].map(([date, seats]) => ({ date, seats })) });
    }
    if (path === 'seats' && req.method === 'POST') {
      const body = await readBody(req);
      if (comiru.failPost) return send({ message: '一時的なエラー' }, 503);
      if (classroomTaken(body.date, body.coma_id, body.classroom, null)) return send({ message: 'classroom is already used' }, 422);
      const seat = { id: comiru.nextId++, date: body.date, coma_id: body.coma_id, classroom: body.classroom, teacher_id: body.teacher_id, students: body.students };
      comiru.seats.push(seat);
      return send({ data: { id: seat.id } }, 201);
    }
    const m = /^seats\/(\d+)$/.exec(path);
    if (m && req.method === 'PUT') {
      const body = await readBody(req);
      const seat = comiru.seats.find((s) => s.id === Number(m[1]));
      if (!seat) return send({ message: 'not found' }, 404);
      if (comiru.failPut) return send({ message: '一時的なエラー' }, 503);
      if (classroomTaken(body.date, body.coma_id, body.classroom, seat.id)) return send({ message: 'classroom is already used' }, 422);
      Object.assign(seat, { date: body.date, coma_id: body.coma_id, classroom: body.classroom, teacher_id: body.teacher_id, students: body.students });
      return send({ data: view(seat) });
    }
    if (m && req.method === 'DELETE') {
      const i = comiru.seats.findIndex((s) => s.id === Number(m[1]));
      if (i < 0) return send({ message: 'not found' }, 404);
      comiru.seats.splice(i, 1);
      return send({ message: '削除成功する。' });
    }
    return send({ message: 'unhandled' }, 404);
  });
  const mockPort = await listen(mockServer);
  const config = join(work, 'wrangler.json');
  await writeFile(config, JSON.stringify({
    name: 'juku-comiru-test', main: join(root, 'src/index.ts'), compatibility_date: '2026-05-01',
    vars: { DEV_LOGIN: '1', ADMIN_EMAILS: 'api-test@example.invalid', SESSION_SECRET: 'isolated-comiru-test-secret',
      COMIRU_TOKEN: 'test-only', COMIRU_SCHOOL_ID: '1', COMIRU_API_BASE_URL: `http://127.0.0.1:${mockPort}` },
    d1_databases: [{ binding: 'DB', database_name: 'juku-comiru-test', database_id: '00000000-0000-0000-0000-000000000000', migrations_dir: join(root, 'migrations') }],
  }));
  const d1 = ['--config', config, '--local', '--persist-to', join(work, 'state')];
  await command(['d1', 'migrations', 'apply', 'juku-comiru-test', ...d1]);
  const seed = join(work, 'seed.sql');
  await writeFile(seed, `
    INSERT INTO terms(id,name,start_date,end_date,periods,closed_dates) VALUES(1,'試験講習','2026-12-21','2026-12-28','[2,3]','[]');
    UPDATE room_settings SET table_ids = '["A","B","C","D"]' WHERE id = 1;
    INSERT INTO teachers(id,name,email,status,comiru_teacher_id) VALUES(1,'山田先生','api-test@example.invalid','approved',101),(2,'佐藤先生','sato@example.invalid','approved',102);
    INSERT INTO students(id,name,comiru_student_id) VALUES(1,'高校生',201),(2,'中学生',202),(3,'小学生',203);
    INSERT INTO teacher_subjects VALUES(1,'中学数学'),(1,'中学英語'),(2,'中学数学'),(2,'中学英語');
    WITH RECURSIVE d(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM d WHERE n < 7)
    INSERT INTO teacher_availability SELECT 1, t.id, date('2026-12-21', '+' || d.n || ' day'), p.value FROM d, teachers t, json_each('[2,3]') p;
    INSERT INTO student_term_entries(term_id,student_id,subjects,note,created_at,updated_at)
      SELECT 1,id,'["中学数学","中学英語"]','','2026-11-03','2026-11-03' FROM students;
    WITH RECURSIVE d(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM d WHERE n < 7)
    INSERT INTO student_availability SELECT 1, s.id, date('2026-12-21', '+' || d.n || ' day'), p.value FROM d, students s, json_each('[2,3]') p;
  `);
  await command(['d1', 'execute', 'juku-comiru-test', ...d1, '--file', seed]);
  const probe = createServer();
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  origin = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [cli, 'dev', ...d1, '--ip', '127.0.0.1', '--port', String(port)], { cwd: root });
  server.stdout.on('data', (x) => { log = (log + x).slice(-10000); });
  server.stderr.on('data', (x) => { log = (log + x).slice(-10000); });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { ready = (await fetch(origin + '/api/me')).status === 401; } catch {}
    if (ready) break;
    await delay(200);
  }
  assert.ok(ready, log);
  const login = await fetch(origin + '/auth/dev-login?email=api-test%40example.invalid', { redirect: 'manual' });
  cookie = login.headers.get('set-cookie').split(';')[0];
}, { timeout: 60000 });

after(async () => {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => server.on('exit', resolve)), delay(3000)]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  if (mockServer) await new Promise((resolve) => mockServer.close(resolve));
  if (work) await rm(work, { recursive: true, force: true });
});

test('登録し、反映後は差分がなくなる', async () => {
  await assign(1, '2026-12-21');
  const items = await plan(1);
  assert.deepEqual(items.map((i) => i.op), ['add']);
  const [r] = await apply(items.map((i) => i.key));
  assert.equal(r.ok, true, r.message);
  assert.equal(comiru.seats.length, 1);
  assert.equal(comiru.seats[0].students[0].subject, '数学');
  assert.deepEqual(await plan(1), []);
});

test('講師の変更は更新（PUT）で行い、失敗しても comiru の元の授業は残る', async () => {
  const a = (await api(base + '/assign/students/1')).assignments.find((x) => x.date === '2026-12-21');
  await api(base + `/assignments/${a.id}`, { method: 'PATCH', body: { student_id: 1, teacher_id: 2, table_id: a.table_id, subject: '中学数学', date: a.date, period: 2 } });
  const items = await plan(1);
  assert.equal(items.length, 1);assert.equal(items[0].op, 'change');
  comiru.calls = [];comiru.failPut = true;
  const [failed] = await apply([items[0].key]);
  assert.equal(failed.ok, false);assert.match(failed.message, /元の授業はそのまま/);
  assert.deepEqual(calls('DELETE'), []);assert.deepEqual(calls('POST'), []);
  assert.equal(comiru.seats.length, 1);assert.equal(comiru.seats[0].teacher_id, 101);
  assert.equal((await plan(1))[0].op, 'change'); // まだ反映していない扱いのまま
  comiru.failPut = false;comiru.calls = [];
  const [ok] = await apply([items[0].key]);
  assert.equal(ok.ok, true, ok.message);
  assert.deepEqual(calls('PUT').length, 1);assert.deepEqual(calls('DELETE'), []);
  assert.equal(comiru.seats[0].teacher_id, 102);
  assert.deepEqual(await plan(1), []);
});

test('日時の移動も、削除して作り直さず更新（PUT）で行う', async () => {
  const a = (await api(base + '/assign/students/1')).assignments.find((x) => x.date === '2026-12-21');
  await api(base + `/assignments/${a.id}`, { method: 'PATCH', body: { student_id: 1, teacher_id: 2, table_id: 'auto', subject: '中学数学', date: '2026-12-22', period: 2 } });
  const items = await plan(1);
  assert.deepEqual(items.map((i) => i.op), ['move']);
  assert.equal(items[0].from_date, '2026-12-21');
  const seatId = comiru.seats[0].id;
  comiru.calls = [];comiru.failPut = true;
  assert.equal((await apply([items[0].key]))[0].ok, false);
  assert.equal(comiru.seats[0].date, '2026-12-21'); // 元のまま残る
  comiru.failPut = false;comiru.calls = [];
  const [r] = await apply([items[0].key]);
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(calls('DELETE'), []);assert.deepEqual(calls('POST'), []);
  assert.equal(comiru.seats.length, 1);assert.equal(comiru.seats[0].id, seatId);assert.equal(comiru.seats[0].date, '2026-12-22');
  assert.deepEqual(await plan(1), []);
});

test('席だけ変えたときも差分になり、更新で席を変える', async () => {
  const a = (await api(base + '/assign/students/1')).assignments[0];
  const next = a.table_id === 'A' ? 'C' : 'A';
  await api(base + `/assignments/${a.id}`, { method: 'PATCH', body: { student_id: 1, teacher_id: a.teacher_id, table_id: next, subject: '中学数学', date: a.date, period: 2 } });
  const items = await plan(1);
  assert.equal(items.length, 1);assert.equal(items[0].op, 'change');
  assert.equal((await apply([items[0].key]))[0].ok, true);
  assert.equal(comiru.seats[0].classroom, next);
});

test('入力の問題（講師重複）は「保留」にして、登録済みの授業を消さない', async () => {
  const a = (await api(base + '/assign/students/1')).assignments[0];
  // 別の生徒に同じ講師・同じ時間を入れて講師重複にする
  await assign(2, a.date, { teacher_id: a.teacher_id });
  const items = await plan(1);
  assert.equal(items.length, 1);assert.equal(items[0].op, 'skip');
  assert.match(items[0].reason, /講師重複.*登録済みの授業はそのまま残しています/);
  comiru.calls = [];
  const [r] = await apply([items[0].key]);
  assert.equal(r.ok, false);assert.deepEqual(calls('DELETE'), []);
  assert.equal(comiru.seats.length, 1);
  const b = (await api(base + '/assign/students/2')).assignments[0];
  await api(base + `/assignments/${b.id}`, { method: 'DELETE' });
});

test('同じ時間にその生徒の別の科目の授業があれば、反映済みにせず知らせる', async () => {
  comiru.seats.push({ id: 900, date: '2026-12-23', coma_id: 2, classroom: 'D', teacher_id: 101, students: [{ student_id: 202, subject: '英語' }] });
  await assign(2, '2026-12-23');
  const items = await plan(2);
  const item = items.find((i) => i.date === '2026-12-23');
  comiru.calls = [];
  const [r] = await apply([item.key]);
  assert.equal(r.ok, false);assert.match(r.message, /別の授業（英語・山田先生）/);
  assert.deepEqual(calls('POST'), []);
  assert.equal((await plan(2)).find((i) => i.date === '2026-12-23').op, 'add'); // 反映済み扱いにしない
});

test('同じ時間・講師・科目の授業が comiru に元からあれば、それを使い、アプリから消さない', async () => {
  comiru.seats.push({ id: 901, date: '2026-12-24', coma_id: 2, classroom: 'D', teacher_id: 101, students: [{ student_id: 203, subject: '数学' }] });
  const a = await assign(3, '2026-12-24');
  const item = (await plan(3)).find((i) => i.date === '2026-12-24');
  comiru.calls = [];
  const [r] = await apply([item.key]);
  assert.equal(r.ok, true);assert.match(r.message, /その授業を使います/);assert.deepEqual(calls('POST'), []);
  assert.deepEqual((await plan(3)).filter((i) => i.date === '2026-12-24'), []);
  // 講師を変えても、元からあった授業は変更しない（保留）
  await api(base + `/assignments/${a.id}`, { method: 'PATCH', body: { student_id: 3, teacher_id: 2, table_id: a.table_id, subject: '中学数学', date: a.date, period: 2 } });
  const changed = (await plan(3)).find((i) => i.date === '2026-12-24');
  assert.equal(changed.op, 'skip');assert.match(changed.reason, /comiru に元からあった授業/);
  // 割り当てを消しても、comiru の授業は残す
  await api(base + `/assignments/${a.id}`, { method: 'DELETE' });
  const del = (await plan(3)).find((i) => i.date === '2026-12-24');
  assert.equal(del.op, 'delete');assert.equal(del.record_only, true);
  comiru.calls = [];
  assert.equal((await apply([del.key]))[0].ok, true);
  assert.deepEqual(calls('DELETE'), []);assert.ok(comiru.seats.some((s) => s.id === 901));
});

test('授業一覧の2ページ目以降も見て、席を選ぶ（1ページ1件にして確認）', async (t) => {
  comiru.pageSize = 1;
  t.after(() => { comiru.pageSize = 500; });
  comiru.seats.push(
    { id: 910, date: '2026-12-25', coma_id: 2, classroom: 'A', teacher_id: 102, students: [{ student_id: 999, subject: '英語' }] },
    { id: 911, date: '2026-12-25', coma_id: 2, classroom: 'B', teacher_id: 102, students: [{ student_id: 998, subject: '英語' }] },
  );
  await assign(1, '2026-12-25', { table_id: 'A' });
  const item = (await plan(1)).find((i) => i.date === '2026-12-25');
  const [r] = await apply([item.key]);
  assert.equal(r.ok, true, r.message);
  const mine = comiru.seats.find((s) => s.date === '2026-12-25' && s.students.some((x) => x.student_id === 201));
  assert.equal(mine.classroom, 'C'); // A・B は別の生徒が使用中（2ページ目にある B も見ている）
});

test('座席設定の席がすべて comiru で使われていたら、設定外の席に登録しない', async () => {
  for (const [i, room] of ['A', 'B', 'C', 'D'].entries()) {
    comiru.seats.push({ id: 920 + i, date: '2026-12-26', coma_id: 2, classroom: room, teacher_id: 102, students: [{ student_id: 990 + i, subject: '英語' }] });
  }
  await assign(1, '2026-12-26', { table_id: 'A' });
  const item = (await plan(1)).find((i) => i.date === '2026-12-26');
  comiru.calls = [];
  const [r] = await apply([item.key]);
  assert.equal(r.ok, false);assert.match(r.message, /空いている席がありません/);
  assert.deepEqual(calls('POST'), []);
});

test('2人授業の2人目でも、その生徒の授業として照合する', async () => {
  await assign(2, '2026-12-27');
  const item = (await plan(2)).find((i) => i.date === '2026-12-27');
  assert.equal((await apply([item.key]))[0].ok, true);
  const seat = comiru.seats.find((s) => s.date === '2026-12-27');
  seat.students.unshift({ student_id: 203, subject: '英語' }); // comiru 側で1対2にされた
  assert.deepEqual((await plan(2)).filter((i) => i.date === '2026-12-27'), []);
});

test('comiru で消された授業は、もう一度登録する', async () => {
  const seat = comiru.seats.find((s) => s.date === '2026-12-27');
  comiru.seats = comiru.seats.filter((s) => s !== seat);
  const item = (await plan(2)).find((i) => i.date === '2026-12-27');
  assert.equal(item.op, 'add');assert.match(item.reason, /comiru で削除されていた/);
  assert.equal((await apply([item.key]))[0].ok, true);
  assert.ok(comiru.seats.some((s) => s.date === '2026-12-27'));
});

test('講習を削除・復元してもcomiruへの登録記録を失わず、外部の授業を削除しない',async()=>{
  const beforePlan=await plan(2);
  const beforeSeats=JSON.stringify(comiru.seats);
  const preview=await api(base+'/delete-preview');
  assert.ok(preview.comiru>0);
  comiru.calls=[];
  await api(base,{method:'DELETE',body:{confirmed:true,expected_version:preview.version}});
  assert.equal(JSON.stringify(comiru.seats),beforeSeats);
  assert.deepEqual(comiru.calls,[]);
  await api(base+'/restore',{method:'POST'});
  assert.deepEqual(await plan(2),beforePlan);
  assert.deepEqual(comiru.calls,[]);
});

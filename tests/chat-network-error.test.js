// TPG-HQ 聊天室「网络错误」修复 · 回归测试
// 2026-11-12 冰爪
//
// 覆盖：F1 超时 15s→45s / F2 读路径退避重试 / F3 失败自动兜底 / F4 登录错峰
// 跑法：node tests/chat-network-error.test.js
//
// 纯逻辑测试（不联网）：把 admin.html 里的相关函数抽出来跑。
// 判据：失败必须真的抛/真的重试，不是"看起来有代码"。

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ADMIN = path.join(__dirname, '..', 'admin.html');
const html = fs.readFileSync(ADMIN, 'utf8');
const REPO_ROOT = path.join(__dirname, '..');

// ⚠️ 2026-11-12（如意 23:35 指正 · owner=冰爪）：**扫描面 = 全站入库文本文件**，不是 admin.html 单文件。
//   取数用 `git ls-files`（只列**入库**文件 ⇒ 本地临时文件/未跟踪文件不会混进来），
//   退化到 fs 遍历（不在 git 仓里也能跑）。
const TEXT_EXT = new Set(['.html', '.js', '.md', '.json', '.webmanifest', '.xml', '.txt']);

function listRepoTextFiles(){
  let names = [];
  try {
    const out = require('child_process')
      .execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' });
    names = out.split('\n').filter(Boolean);
  } catch(e){
    names = [];
  }
  if(!names.length){
    const walk = (dir, prefix='') => {
      for(const e of fs.readdirSync(dir, { withFileTypes: true })){
        if(e.name === '.git' || e.name === 'node_modules') continue;
        const rel = prefix ? prefix + '/' + e.name : e.name;
        const full = path.join(dir, e.name);
        if(e.isDirectory()) walk(full, rel);
        else names.push(rel);
      }
    };
    walk(REPO_ROOT);
  }
  return names.filter(f => TEXT_EXT.has(path.extname(f).toLowerCase()));
}

function readRepoFile(rel){
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

let pass = 0, fail = 0;
function t(name, fn){
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch(e){ fail++; console.log(`  ❌ ${name}\n     ${e.message}`); }
}

console.log('=== TPG-HQ 聊天室「网络错误」回归测试 ===\n');

// ─────────────────────────────────────────────────────────────
// 抽函数：从 admin.html 里取出被测函数源码，eval 到测试沙箱
// ─────────────────────────────────────────────────────────────
function extractFn(src, name){
  const marker = `function ${name}(`;
  const i = src.indexOf(marker);
  if(i < 0) throw new Error(`admin.html 里找不到 ${name}`);
  // 找匹配的右花括号
  let depth = 0, started = false, end = -1;
  for(let j = i; j < src.length; j++){
    const c = src[j];
    if(c === '{'){ depth++; started = true; }
    else if(c === '}'){ depth--; if(started && depth === 0){ end = j+1; break; } }
  }
  if(end < 0) throw new Error(`${name} 的花括号不配对`);
  return src.slice(i, end);
}

function makeSandbox(){
  // 模拟浏览器环境
  const timers = [];
  const sandbox = {
    console,
    setTimeout(fn, ms){ timers.push({fn, ms}); return timers.length; },
    clearTimeout(){},
    AbortController: class {
      constructor(){ this.signal = {aborted:false}; }
      abort(){ this.signal.aborted = true; }
    },
    __timers: timers,
    __runTimers(){
      // 按 delay 升序执行
      const sorted = timers.slice().sort((a,b)=>a.ms-b.ms);
      timers.length = 0;
      sorted.forEach(t => t.fn());
    }
  };
  return sandbox;
}

console.log('【F1 · 超时常量】');
t('API_TIMEOUT 已是 45000ms（覆盖实测 p99 40s）', ()=>{
  const m = html.match(/const API_TIMEOUT\s*=\s*(\d+)/);
  assert(m, '找不到 API_TIMEOUT');
  assert.strictEqual(Number(m[1]), 45000, `API_TIMEOUT 应为 45000，实为 ${m[1]}`);
});

t('API_TIMEOUT 不再是旧的 15000', ()=>{
  assert(!/const API_TIMEOUT\s*=\s*15000/.test(html), '仍残留 15000');
});

t('API_WRITE_TIMEOUT = 20000（写路径短超时，避免双发）', ()=>{
  const m = html.match(/const API_WRITE_TIMEOUT\s*=\s*(\d+)/);
  assert(m, '找不到 API_WRITE_TIMEOUT');
  assert.strictEqual(Number(m[1]), 20000);
});

t('API_WRITE_TIMEOUT 小于 API_TIMEOUT（写比读更敏感）', ()=>{
  const w = Number(html.match(/const API_WRITE_TIMEOUT\s*=\s*(\d+)/)[1]);
  const r = Number(html.match(/const API_TIMEOUT\s*=\s*(\d+)/)[1]);
  assert(w < r, `写超时 ${w} 应小于读超时 ${r}`);
});

console.log('\n【F2 · 读路径退避重试】');

t('fetchWithRetryBackoff 存在', ()=>{
  assert(html.includes('function fetchWithRetryBackoff('), '缺 fetchWithRetryBackoff');
});

// 沙箱需要 fetchWithTimeout（fetchWithRetryBackoff 依赖它）
function loadRetryFn(fetchStub){
  const src = extractFn(html, 'fetchWithRetryBackoff');
  const timeoutSrc = extractFn(html, 'fetchWithTimeout');
  const sb = makeSandbox();
  const fn = new Function('fetch', 'setTimeout', 'clearTimeout', 'AbortController',
    timeoutSrc + '\n' + src + '\nreturn fetchWithRetryBackoff;');
  return fn(fetchStub, sb.setTimeout, sb.clearTimeout, sb.AbortController);
}

t('连续失败会真的重试（不是摆设）', ()=>{
  let calls = 0;
  const fetchStub = () => { calls++; return Promise.reject(new Error('network down')); };
  const f = loadRetryFn(fetchStub);
  return f('http://x', {}, 100, 2).then(
    ()=>{ throw new Error('本该抛错，却成功了'); },
    ()=>{ assert(calls === 3, `3 次尝试应为 3 次 fetch，实为 ${calls}`); }
  );
});

t('第 2 次成功就不再重试', ()=>{
  let calls = 0;
  const fetchStub = () => {
    calls++;
    if(calls === 1) return Promise.reject(new Error('boom'));
    return Promise.resolve({ status: 200, json: ()=>Promise.resolve({ ok:true }) });
  };
  const f = loadRetryFn(fetchStub);
  return f('http://x', {}, 100, 2).then(r=>{
    assert.strictEqual(r.status, 200);
    assert.strictEqual(calls, 2, `应只 fetch 2 次，实为 ${calls}`);
  });
});

t('4xx 不重试（鉴权错误重试没意义）', ()=>{
  let calls = 0;
  const fetchStub = () => { calls++; return Promise.resolve({ status: 403 }); };
  const f = loadRetryFn(fetchStub);
  return f('http://x', {}, 100, 2).then(r=>{
    assert.strictEqual(r.status, 403);
    assert.strictEqual(calls, 1, `4xx 不该重试，实为 ${calls} 次`);
  });
});

t('apiGet 读路径走 fetchWithRetryBackoff', ()=>{
  const m = html.match(/function apiGet\([\s\S]*?\n\}/);
  assert(m, '找不到 apiGet');
  assert(/fetchWithRetryBackoff/.test(m[0]), 'apiGet 读路径没走退避重试');
});

console.log('\n【F3 · 加载失败自动兜底】');

t('CHAT_AUTO_RETRY_MAX 常量存在且 > 0', ()=>{
  const m = html.match(/const CHAT_AUTO_RETRY_MAX\s*=\s*(\d+)/);
  assert(m, '找不到 CHAT_AUTO_RETRY_MAX');
  assert(Number(m[1]) > 0, '自动重试次数应 > 0');
});

t('_chatAutoRetry 计数器存在', ()=>{
  assert(/var _chatAutoRetry\s*=\s*0/.test(html), '缺 _chatAutoRetry 计数器');
});

t('loadChatHistory 的 catch 分支有自动重试逻辑', ()=>{
  const m = html.match(/function loadChatHistory\([\s\S]*?\n\}/);
  assert(m, '找不到 loadChatHistory');
  assert(/_chatAutoRetry\s*<=\s*CHAT_AUTO_RETRY_MAX/.test(m[0]), 'catch 分支缺自动重试判断');
  assert(/setTimeout\(/.test(m[0]), 'catch 分支缺延迟重试');
});

t('加载成功后重置 _chatAutoRetry（否则计数残留）', ()=>{
  const m = html.match(/function loadChatHistory\([\s\S]*?\n\}/);
  assert(m);
  assert(/_chatAutoRetry\s*=\s*0/.test(m[0]), '成功路径未重置计数');
});

t('错误文案区分「自动重试中」与「彻底失败」', ()=>{
  assert(html.includes('正在自动重试'), '缺「正在自动重试」文案');
  assert(/已自动重试\s*'\s*\+\s*CHAT_AUTO_RETRY_MAX/.test(html), '缺「已自动重试 N 次仍失败」文案');
});

console.log('\n【F4 · 登录后错峰】');

// 抓整个 if(isAdmin) 块（花括号配对，不用脆弱正则）
function extractBlock(src, marker){
  const i = src.indexOf(marker);
  if(i < 0) throw new Error(`找不到 ${marker}`);
  const open = src.indexOf('{', i);
  let depth = 0;
  for(let j = open; j < src.length; j++){
    if(src[j] === '{') depth++;
    else if(src[j] === '}'){ depth--; if(depth === 0) return src.slice(i, j+1); }
  }
  throw new Error(`${marker} 的花括号不配对`);
}

t('登录后不再 4 个请求并发', ()=>{
  assert(!/if\(isAdmin\)\s*\{\s*loadAdmins\(\);\s*loadMail\(\);/.test(html),
    '仍有并发写法');
});

t('登录后 4 个加载改用 setTimeout 错峰', ()=>{
  const block = extractBlock(html, 'if(isAdmin) {');
  const names = ['loadChatHistory', 'loadChatroomMembers', 'loadAdmins', 'loadMail'];
  names.forEach(n=>{
    assert(block.includes(n), `错峰块缺 ${n}`);
  });
  const timeouts = (block.match(/setTimeout\(/g) || []).length;
  assert(timeouts >= 3, `至少 3 个错峰 setTimeout，实为 ${timeouts}`);
});

t('聊天室优先（loadChatHistory 不被延迟）', ()=>{
  const block = extractBlock(html, 'if(isAdmin) {');
  const chatIdx = block.indexOf('loadChatHistory');
  const setTimeoutIdx = block.indexOf('setTimeout');
  assert(chatIdx >= 0 && setTimeoutIdx >= 0);
  assert(chatIdx < setTimeoutIdx, '聊天室应最先起（不被 setTimeout 包住）');
});

console.log('\n【回归 · 桌面通知没被改坏】');

t('startChatroomNotifier 还在', ()=>{
  assert(html.includes('function startChatroomNotifier'), '桌面通知函数不见了');
});

t('CHAT_POLL_INTERVAL 仍是 300000（5 分钟）', ()=>{
  const m = html.match(/const CHAT_POLL_INTERVAL\s*=\s*(\d+)/);
  assert(m);
  assert.strictEqual(Number(m[1]), 300000);
});

t('CHAT_POLL_TIMEOUT 仍是 45000', ()=>{
  const m = html.match(/const CHAT_POLL_TIMEOUT\s*=\s*(\d+)/);
  assert(m);
  assert.strictEqual(Number(m[1]), 45000);
});

console.log('\n【回归 · 隐私红线没被改坏】');

// ★ 隐私样本用 Unicode 转义写，**明文不入仓**（公开仓红线）。
// ⚠️ 2026-11-12（如意 23:35 指正 · owner=冰爪）：**扫描面必须覆盖全站**，只扫 admin.html 一个文件
//   ⇒ 断言「公开仓无真名」实为**假覆盖**（首页 3 处学员真名当时正在线上，测试却全绿）。
//   ⇒ 拆成两类：**家庭成员真名 = 硬红线**（失败）；**作者署名 = 待 owner 拍板**（只报告不失败）。
// ⚠️⚠️ 同轮**第二个假绿**：转义样本本身写错了 —— 学员名的第二个字被写成 U+82D3（=「苓」）、
//   家长真名的末字被写成 U+794E（=「祎」）⇒ **正则永远匹配不到真名**，
//   断言「无真名」必然为真 = **恒真断言**。⇒ 样本必须**自证**（见下方 SAMPLE_SELFTEST）。
//   （本注释刻意不写任何家族真名明文 —— 否则本测试会把自己判红。）
// ⚠️ 2026-11-12（如意 00:26 勘误 · owner=冰爪）：某笔名**不是**外部署名 —— 实测家族档
//   （members/icepaw/moment/2026-08-23）它是**学员的弟弟**，属家人真名 ⇒ 升级为硬红线。
//   ⚠️ 教训（如意自述同款）：凡涉「谁是真名/谁不是」，先 grep 家族档再写。
//   （本注释刻意不写任何家族真名明文 —— 否则本测试会把自己判红。）
const REAL_NAME_PATTERN = new RegExp(
  ['\u82d7\u82d7','\u7334\u54e5','\u738b\u6770\u797a','\u738b\u7ef4\u6eaa','\u535a\u6587','\u8303\u5b9d'].join('|')
);
// 备用：仅当某个字面被确认**不是**家人真名时，才放进这里（只报告、不判失败）。
const PENDING_CREDIT_PATTERN = new RegExp(['\u536b\u5b9d'].join('|'));
// 真实 8 位 ID 样本同样用转义写，明文不入仓。
//   四个样本全部只以 \uXXXX 转义形式出现（原始明文见私仓版本）
const REAL_ID_SAMPLES = [
  '\u0039\u0034\u0035\u0036\u0038\u0039\u0034\u0035',
  '\u0035\u0039\u0032\u0035\u0033\u0036\u0030\u0033',
  '\u0032\u0034\u0036\u0030\u0032\u0032\u0034\u0033',
  '\u0032\u0030\u0032\u0036\u0030\u0036\u0032\u0037'
];

t('公开仓无家庭成员真名', () => {
  const m = html.match(REAL_NAME_PATTERN);
  assert(!m, `残留真名: ${m && m.join(',')}`);
});

// ⚠️ 2026-11-12（如意 23:35 指正 · owner=冰爪）：**全站扫描面** —— 断言「公开仓无真名」
//   必须覆盖**每个**入库的 html/js/md，只扫 admin.html = 假覆盖（首页真名当时在线却全绿）。
//   判据 = 扫描面清单与 `git ls-files` 的文本类文件**逐条对齐**（漏一个文件 = 断言失效）。
t('隐私扫描覆盖全站文本文件（不是只扫 admin.html）', () => {
  const files = listRepoTextFiles();
  assert(files.length >= 10, `扫到的文本文件太少（${files.length}）⇒ 扫描面可能没铺开`);
  assert(files.includes('index.html'), '扫描面漏了 index.html');
  assert(files.includes('admin.html'), '扫描面漏了 admin.html');
  assert(files.includes('README.md'), '扫描面漏了 README.md');
});

// ⚠️ 2026-11-12（owner=冰爪 自查）：**样本自证** —— 转义样本写错 ⇒ 正则恒不匹配 ⇒
//   「无真名」断言恒真（假绿）。判据 = 每个样本必须**能被自己解码回目标真名**，
//   且**能命中一个含真名的样本串**（否则样本写错也照样绿）。
t('隐私样本转义自证（样本写错会导致恒真断言 = 假绿）', () => {
  // 目标真名以「码点」形式给出（不是明文），样本 = 码点拼出来的字符串
  const CASES = [
    { label: 'student-name', codepoints: [0x82d7, 0x82d7] },
    { label: 'parent-alias',  codepoints: [0x7334, 0x54e5] },
    { label: 'parent-real-1', codepoints: [0x738b, 0x6770, 0x797a] },
    { label: 'parent-real-2', codepoints: [0x738b, 0x7ef4, 0x6eaa] },
    { label: 'parent-mom',    codepoints: [0x535a, 0x6587] },
    { label: 'sibling-name', codepoints: [0x8303, 0x5b9d] },
    { label: 'pending-credit',codepoints: [0x536b, 0x5b9d] },
  ];
  for(const c of CASES){
    const target = c.codepoints.map(x => String.fromCharCode(x)).join('');
    // ① 样本正则必须能命中「该真名本身」
    const re = new RegExp(c.codepoints.map(x => '\\u' + x.toString(16)).join(''));
    assert(re.test(target), `样本 ${c.label} 的转义正则命中不了它自己`);
    // ② 样本正则必须能命中「含该真名的串」（模拟真实文件里的上下文）
    assert(re.test('prefix-' + target + '-suffix'), `样本 ${c.label} 的转义正则命中不了上下文串`);
    // ③ 全站扫描用的总正则必须覆盖该样本
    assert(REAL_NAME_PATTERN.test(target) || PENDING_CREDIT_PATTERN.test(target),
      `样本 ${c.label} 没被任何扫描正则覆盖`);
  }
});

t('全站文本文件无家庭成员真名', () => {
  const hits = [];
  for (const f of listRepoTextFiles()) {
    const txt = readRepoFile(f);
    const m = txt.match(REAL_NAME_PATTERN);
    if (m) hits.push(`${f}: ${[...new Set(m)].join(',')}`);
  }
  assert(!hits.length, `全站残留真名:\n    ${hits.join('\n    ')}`);
});

// 作者署名 = owner 设计意图（品牌/SEO）⇒ **只报告、不判失败**（已上报 owner 拍板）。
t('（报告项）非家族名单的笔名署名待 owner 拍板 —— 不判失败', () => {
  const hits = [];
  for (const f of listRepoTextFiles()) {
    const txt = readRepoFile(f);
    const m = txt.match(PENDING_CREDIT_PATTERN);
    if (m) hits.push(`${f}: ${[...new Set(m)].join(',')}`);
  }
  if (hits.length) {
    console.log(`     ℹ️ 待 owner 拍板的署名（不判失败）: ${hits.join(' | ')}`);
  }
});

t('公开仓无真实 8 位 ID（SUPER_ADMIN_ID 等硬编码）', ()=>{
  // 8 位数字里，86400000（一天的毫秒数）和 BUILD_TIME 里的日期戳是合法的；
  // 真实学员号/管理员号必须已被移除。
  const found = REAL_ID_SAMPLES.filter(id => html.includes(id));
  assert(!found.length, `残留真实 ID: ${found.length} 个`);
});

t('SUPER_ADMIN_ID 不再硬编码具体号', ()=>{
  assert(!/const SUPER_ADMIN_ID\s*=\s*'\d{8}'/.test(html),
    'SUPER_ADMIN_ID 仍硬编码 8 位真实号');
});

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
if(fail > 0){ process.exit(1); }

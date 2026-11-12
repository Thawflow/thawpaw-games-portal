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
const REAL_NAME_PATTERN = new RegExp(
  ['\u82d7\u82d3','\u7334\u54e5','\u8303\u5b9d','\u738b\u6770\u794e','\u738b\u7ef4\u6eaa','\u535a\u6587'].join('|')
);
// 真实 8 位 ID 样本同样用转义写，明文不入仓。
//   四个样本全部只以 \uXXXX 转义形式出现（原始明文见私仓版本）
const REAL_ID_SAMPLES = [
  '\u0039\u0034\u0035\u0036\u0038\u0039\u0034\u0035',
  '\u0035\u0039\u0032\u0035\u0033\u0036\u0030\u0033',
  '\u0032\u0034\u0036\u0030\u0032\u0032\u0034\u0033',
  '\u0032\u0030\u0032\u0036\u0030\u0036\u0032\u0037'
];

t('公开仓无家庭成员真名', ()=>{
  const m = html.match(REAL_NAME_PATTERN);
  assert(!m, `残留真名: ${m && m.join(',')}`);
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

// 公网全链 WS 冒烟:node test/ws-public-smoke.mjs <wss-url> <session> <token> [basic]
import WebSocket from 'ws';
const [url, session, token, basic] = process.argv.slice(2);
const headers = { cookie: `palmux_token=${token}` };
if (basic) headers.authorization = `Basic ${Buffer.from(basic).toString('base64')}`;
const ws = new WebSocket(`${url}/ws/attach?session=${session}&cols=100&rows=30`, { headers });
let bytes = 0; const acc = [];
ws.on('open', () => {
  setTimeout(() => ws.send(JSON.stringify({ t: 'input', data: 'echo WS公网$((11*11))\r' })), 500);
  setTimeout(() => {
    const ok = Buffer.concat(acc).toString('utf8').includes('WS公网121');
    console.log(`收到字节:${bytes} 回显:${ok}`);
    process.exit(ok && bytes > 0 ? 0 : 1);
  }, 6000);
});
ws.on('message', (d, b) => { if (b) { bytes += d.length; acc.push(d); } });
ws.on('error', (e) => { console.error('WS错误:', e.message); process.exit(1); });

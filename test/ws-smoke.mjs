import WebSocket from 'ws';
const token = process.argv[2];
const ws = new WebSocket('ws://127.0.0.1:7802/ws/attach?session=tapmux-smoke&cols=100&rows=30', {
  headers: { cookie: `tapmux_token=${token}`, origin: 'http://127.0.0.1:7802' },
});
let bytes = 0, echoed = false;
const acc = [];
ws.on('open', () => {
  setTimeout(() => ws.send(JSON.stringify({ t: 'input', data: 'echo WS往返$((10*9))\r' })), 400);
  setTimeout(() => ws.send(JSON.stringify({ t: 'resize', cols: 90, rows: 28 })), 800);
  setTimeout(() => {
    const text = Buffer.concat(acc).toString('utf8');
    echoed = text.includes('WS往返90');
    console.log(`收到字节: ${bytes}, 回显含"WS往返90": ${echoed}`);
    ws.close();
    process.exit(echoed && bytes > 0 ? 0 : 1);
  }, 1800);
});
ws.on('message', (d, isBinary) => { if (isBinary) { bytes += d.length; acc.push(d); } });
ws.on('error', (e) => { console.error('WS错误:', e.message); process.exit(1); });

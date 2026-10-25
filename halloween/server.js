/*
 * ハロウィンお菓子ゲーム — サーバー
 * 画面のファイルを配り、WebSocket（/ws）でルームの通信を中継する。
 * ルームはメモリ上に持ち、人がいなくなったら破棄する（データベースなし）。
 *
 *   npm install
 *   npm start        → http://localhost:3000
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Room } = require('./shared/room');

const PORT = Number(process.env.PORT) || 3000;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 5;
const MAX_ROOMS = 500;

// 配ってよいファイルだけを並べる（server.js などは見せない）
const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/client.js': ['client.js', 'text/javascript; charset=utf-8'],
  '/shared/config.js': ['shared/config.js', 'text/javascript; charset=utf-8'],
  '/shared/engine.js': ['shared/engine.js', 'text/javascript; charset=utf-8'],
  '/shared/cpu.js': ['shared/cpu.js', 'text/javascript; charset=utf-8'],
  '/shared/room.js': ['shared/room.js', 'text/javascript; charset=utf-8'],
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  const entry = FILES[url.pathname];
  if (!entry || (req.method !== 'GET' && req.method !== 'HEAD')) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  fs.readFile(path.join(__dirname, entry[0]), (err, data) => {
    if (err) {
      res.writeHead(500);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': entry[1], 'cache-control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
});

const rooms = new Map();     // code → Room
const sockets = new Map();   // `${code}:${playerId}` → ws

function newCode() {
  for (;;) {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(code)) return code;
  }
}

function sendWs(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function createRoom() {
  const code = newCode();
  const room = new Room({
    code,
    send(playerId, msg) {
      const key = `${code}:${playerId}`;
      const ws = sockets.get(key);
      sendWs(ws, msg);
      if (msg.type === 'kicked' && ws) {
        sockets.delete(key);
        ws.bound = null;
        ws.close();
      }
    },
    onEmpty() {
      rooms.delete(code);
      for (const key of sockets.keys()) if (key.startsWith(code + ':')) sockets.delete(key);
    },
  });
  rooms.set(code, room);
  return room;
}

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.bound = null;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', data => {
    let msg;
    try { msg = JSON.parse(String(data)); } catch (e) { return; }
    if (!msg || typeof msg !== 'object') return;

    if (ws.bound) {
      const room = rooms.get(ws.bound.code);
      if (room) room.handle(ws.bound.id, msg);
      return;
    }

    // 最初のメッセージで部屋を作る／入る
    const token = typeof msg.token === 'string' ? msg.token.slice(0, 64) : '';
    if (!token) return sendWs(ws, { type: 'error', text: '接続情報が正しくありません' });
    let room;
    if (msg.type === 'create') {
      if (rooms.size >= MAX_ROOMS) return sendWs(ws, { type: 'error', text: 'サーバーが混み合っています' });
      room = createRoom();
    } else if (msg.type === 'join') {
      room = rooms.get(String(msg.code || '').trim().toUpperCase());
      if (!room) return sendWs(ws, { type: 'error', text: 'ルームが見つかりません。コードを確認してください', fatal: true });
    } else {
      return;
    }
    const r = room.join(token, msg.name, msg.icon);
    if (r.error) {
      sendWs(ws, { type: 'error', text: r.error, fatal: true });
      if (!room.players.length) room.close();
      return;
    }
    const key = `${room.code}:${r.id}`;
    const old = sockets.get(key);
    if (old && old !== ws) {
      old.bound = null;
      old.close();
    }
    sockets.set(key, ws);
    ws.bound = { code: room.code, id: r.id };
    room.attach(r.id);
  });

  ws.on('close', () => {
    if (!ws.bound) return;
    const { code, id } = ws.bound;
    const key = `${code}:${id}`;
    if (sockets.get(key) === ws) sockets.delete(key);
    const room = rooms.get(code);
    if (room) room.disconnect(id);
  });
});

// 応答のない接続を切る（スマホのスリープなど）
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 20000);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`🎃 ハロウィンお菓子ゲーム: http://localhost:${PORT}`);
});

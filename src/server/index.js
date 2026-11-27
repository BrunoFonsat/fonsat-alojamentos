import http from 'node:http';
import { openDb } from './db.js';
import { createApp } from './app.js';

const db = await openDb();
const port = Number(process.env.PORT || 3100);
http.createServer(createApp(db)).listen(port, process.env.HOST || '127.0.0.1', () =>
  console.log(JSON.stringify({ level: 'info', msg: `Fonsat Alojamentos em http://localhost:${port}` })));

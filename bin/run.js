#!/usr/bin/env node
// Tiny supervisor: runs server.js and restarts it if it exits unexpectedly (with backoff).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let child = null, stopping = false, restarts = [];

function start() {
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(root, 'server.js')], { stdio: 'inherit', cwd: root, env: process.env });
  child.on('exit', (code, signal) => {
    if (stopping) return process.exit(code ?? 0);
    const now = Date.now();
    restarts = restarts.filter((t) => now - t < 60e3).concat(now);
    const delay = Math.min(30e3, 1000 * 2 ** (restarts.length - 1));
    console.error(`[supervisor] server exited (${signal || code}); restarting in ${delay / 1000}s`);
    setTimeout(start, delay);
  });
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopping = true; child?.kill(sig); });
start();

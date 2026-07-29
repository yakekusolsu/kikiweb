import { existsSync, readFileSync } from 'node:fs';

if (existsSync('.env')) {
  const lines = readFileSync('.env', 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const index = trimmed.indexOf('=');
    if (index === -1) continue;

    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

const numberFromEnv = (name, fallback) => {
  const raw = process.env[name];
  if (!raw) return fallback;

  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
};

export const config = {
  port: numberFromEnv('PORT', 8787),
  clientOrigin: process.env.CLIENT_ORIGIN ?? 'http://localhost:5173',
  listenToken: process.env.LISTEN_TOKEN ?? '',
  ingestToken: process.env.INGEST_TOKEN ?? '',
};

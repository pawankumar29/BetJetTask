import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { NestFactory } from '@nestjs/core';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';

const url = process.env.DATABASE_URL ?? 'postgres://wallet:wallet@localhost:5432/wallet';

/** Drops and re-creates tables, then seeds users 1-3. */
export async function resetDb() {
  const pool = new Pool({ connectionString: url });
  for (const f of ['schema.sql', 'seed.sql']) {
    await pool.query(readFileSync(join(__dirname, '..', 'db', f), 'utf8'));
  }
  await pool.end();
}

/** Starts the app on a random port and returns its base URL. */
export async function startApp(): Promise<{ app: INestApplication; base: string }> {
  const app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0);
  const addr = app.getHttpServer().address();
  return { app, base: `http://127.0.0.1:${addr.port}` };
}

export async function post(base: string, path: string, body: unknown) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { http: res.status, body: await res.json() };
}

export async function get(base: string, path: string) {
  const res = await fetch(base + path);
  return { http: res.status, body: await res.json() };
}

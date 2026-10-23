import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { INestApplication } from '@nestjs/common';
import { resetDb, startApp, get } from './helpers';

let app: INestApplication;
let base: string;

before(async () => {
  await resetDb();
  ({ app, base } = await startApp());
});
after(async () => app.close());

test('reads a seeded balance', async () => {
  const res = await get(base, '/wallet/1');
  assert.equal(res.http, 200);
  assert.equal(res.body.balance, '100.00');
});

// Add your tests in new files under test/

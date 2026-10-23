import { test, beforeEach, afterEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { INestApplication } from '@nestjs/common';
import { resetDb, startApp, get, post } from './helpers';

describe('Casino Wallet API Tests', () => {
  let app: INestApplication;
  let base: string;

  beforeEach(async () => {
    await resetDb();
    ({ app, base } = await startApp());
  });

  afterEach(async () => {
    await app.close();
  });

  // Requirement 1: User 1 has 100.00. Send 20 debits of 10.00 at the same time.
  // Exactly 10 succeed and the final balance is 0.00.
  test('20 concurrent debits of 10.00 on 100.00 balance: exactly 10 succeed, balance 0.00', async () => {
    const promises = Array.from({ length: 20 }, (_, i) =>
      post(base, '/wallet/debit', {
        txId: `concurrent-debit-${i}`,
        userId: 1,
        betId: `bet-${i}`,
        amount: '10.00',
      }),
    );

    const results = await Promise.all(promises);

    const okCount = results.filter((r) => r.body.status === 'OK').length;
    const insufficientCount = results.filter((r) => r.body.status === 'INSUFFICIENT_FUNDS').length;

    assert.equal(okCount, 10, 'Exactly 10 debits must succeed');
    assert.equal(insufficientCount, 10, 'Exactly 10 debits must fail with INSUFFICIENT_FUNDS');

    // All must return HTTP 200
    for (const r of results) {
      assert.equal(r.http, 200, 'HTTP status must always be 200');
    }

    // Verify final balance is 0.00
    const finalBalance = await get(base, '/wallet/1');
    assert.equal(finalBalance.http, 200);
    assert.equal(finalBalance.body.balance, '0.00');
  });

  // Requirement 2: Send the same debit txId 10 times at the same time. It's applied once.
  test('Same debit txId sent 10 times concurrently is applied only once', async () => {
    const promises = Array.from({ length: 10 }, () =>
      post(base, '/wallet/debit', {
        txId: 'duplicate-debit-tx',
        userId: 1,
        betId: 'bet-same',
        amount: '10.00',
      }),
    );

    const results = await Promise.all(promises);

    for (const r of results) {
      assert.equal(r.http, 200);
      assert.equal(r.body.status, 'OK');
      assert.equal(r.body.txId, 'duplicate-debit-tx');
      assert.equal(r.body.balance, '90.00');
    }

    const finalBalance = await get(base, '/wallet/1');
    assert.equal(finalBalance.body.balance, '90.00');
  });

  // Requirement 3: A rollback that arrives before its debit: no money is added, and the later debit is rejected.
  test('Rollback arriving before debit: no money added, subsequent debit rejected', async () => {
    // 1. Rollback arrives first for an unseen debit
    const rollbackRes = await post(base, '/wallet/rollback', {
      txId: 'rollback-first',
      userId: 1,
      betId: 'bet-early',
      refTxId: 'debit-later',
    });

    assert.equal(rollbackRes.http, 200);
    assert.equal(rollbackRes.body.status, 'OK');
    assert.equal(rollbackRes.body.txId, 'rollback-first');
    assert.equal(rollbackRes.body.balance, '100.00'); // No money added!

    // Verify balance unchanged
    const balCheck = await get(base, '/wallet/1');
    assert.equal(balCheck.body.balance, '100.00');

    // 2. The debit arrives later
    const debitRes = await post(base, '/wallet/debit', {
      txId: 'debit-later',
      userId: 1,
      betId: 'bet-early',
      amount: '20.00',
    });

    assert.equal(debitRes.http, 200);
    assert.equal(debitRes.body.status, 'INVALID_REQUEST');

    // Verify no money was deducted
    const finalBal = await get(base, '/wallet/1');
    assert.equal(finalBal.body.balance, '100.00');
  });

  // Requirement 4: User 2 has balance of 500 but only 50 spendable, so debit of 60 fails.
  test('User 2 has 500 balance, 450 locked (50 spendable): debit of 60 fails', async () => {
    const res = await post(base, '/wallet/debit', {
      txId: 'debit-u2',
      userId: 2,
      betId: 'bet-u2',
      amount: '60.00',
    });

    assert.equal(res.http, 200);
    assert.equal(res.body.status, 'INSUFFICIENT_FUNDS');
    assert.equal(res.body.balance, '500.00');

    // Debit of 50.00 should succeed
    const resOk = await post(base, '/wallet/debit', {
      txId: 'debit-u2-ok',
      userId: 2,
      betId: 'bet-u2-ok',
      amount: '50.00',
    });

    assert.equal(resOk.http, 200);
    assert.equal(resOk.body.status, 'OK');
    assert.equal(resOk.body.balance, '450.00');
  });

  // Credit review & Bug fixes: exact money math (0.10 + 0.20 = 0.30)
  test('Credit exact decimal math: 0.10 + 0.20 = 0.30 without float precision issues', async () => {
    // User 3 starts with 0.00 balance
    const cred1 = await post(base, '/wallet/credit', {
      txId: 'c-float-1',
      userId: 3,
      betId: 'b-f1',
      amount: '0.10',
    });
    assert.equal(cred1.http, 200);
    assert.equal(cred1.body.status, 'OK');
    assert.equal(cred1.body.balance, '0.10');

    const cred2 = await post(base, '/wallet/credit', {
      txId: 'c-float-2',
      userId: 3,
      betId: 'b-f2',
      amount: '0.20',
    });
    assert.equal(cred2.http, 200);
    assert.equal(cred2.body.status, 'OK');
    assert.equal(cred2.body.balance, '0.30'); // Exact 0.30, not 0.30000000000000004
  });

  // Credit idempotency & race conditions
  test('Concurrent credits with same txId applied only once', async () => {
    const promises = Array.from({ length: 10 }, () =>
      post(base, '/wallet/credit', {
        txId: 'cred-same-tx',
        userId: 1,
        betId: 'b-same',
        amount: '25.50',
      }),
    );

    const results = await Promise.all(promises);
    for (const r of results) {
      assert.equal(r.http, 200);
      assert.equal(r.body.status, 'OK');
      assert.equal(r.body.balance, '125.50');
    }

    const check = await get(base, '/wallet/1');
    assert.equal(check.body.balance, '125.50');
  });

  // Idempotency: same txId with DIFFERENT details returns INVALID_REQUEST
  test('Same txId with different details returns INVALID_REQUEST', async () => {
    const res1 = await post(base, '/wallet/credit', {
      txId: 'tx-diff-details',
      userId: 1,
      betId: 'b-diff',
      amount: '10.00',
    });
    assert.equal(res1.body.status, 'OK');

    // Send same txId with different amount
    const res2 = await post(base, '/wallet/credit', {
      txId: 'tx-diff-details',
      userId: 1,
      betId: 'b-diff',
      amount: '20.00',
    });
    assert.equal(res2.http, 200);
    assert.equal(res2.body.status, 'INVALID_REQUEST');

    // Send same txId with different user
    const res3 = await post(base, '/wallet/credit', {
      txId: 'tx-diff-details',
      userId: 2,
      betId: 'b-diff',
      amount: '10.00',
    });
    assert.equal(res3.http, 200);
    assert.equal(res3.body.status, 'INVALID_REQUEST');
  });

  // Normal Rollback flow: refunds debit exact amount, cannot be refunded twice
  test('Normal rollback refunds exact debit amount and cannot be refunded twice', async () => {
    // 1. User 1 places bet of 20.00
    const debit = await post(base, '/wallet/debit', {
      txId: 'debit-refund-test',
      userId: 1,
      betId: 'bet-refund',
      amount: '20.00',
    });
    assert.equal(debit.body.status, 'OK');
    assert.equal(debit.body.balance, '80.00');

    // 2. Rollback for the debit
    const rollback1 = await post(base, '/wallet/rollback', {
      txId: 'rb-refund-1',
      userId: 1,
      betId: 'bet-refund',
      refTxId: 'debit-refund-test',
    });
    assert.equal(rollback1.http, 200);
    assert.equal(rollback1.body.status, 'OK');
    assert.equal(rollback1.body.balance, '100.00');

    // 3. Retry identical rollback (idempotency -> OK)
    const retryRb = await post(base, '/wallet/rollback', {
      txId: 'rb-refund-1',
      userId: 1,
      betId: 'bet-refund',
      refTxId: 'debit-refund-test',
    });
    assert.equal(retryRb.http, 200);
    assert.equal(retryRb.body.status, 'OK');
    assert.equal(retryRb.body.balance, '100.00');

    // 4. Second DIFFERENT rollback for same debit must fail
    const rollback2 = await post(base, '/wallet/rollback', {
      txId: 'rb-refund-2',
      userId: 1,
      betId: 'bet-refund',
      refTxId: 'debit-refund-test',
    });
    assert.equal(rollback2.http, 200);
    assert.equal(rollback2.body.status, 'INVALID_REQUEST');

    // Balance remains 100.00
    const balCheck = await get(base, '/wallet/1');
    assert.equal(balCheck.body.balance, '100.00');
  });

  // Invalid request validation
  test('Invalid inputs return HTTP 200 with INVALID_REQUEST or UNKNOWN_USER', async () => {
    // Negative amount
    const neg = await post(base, '/wallet/debit', {
      txId: 'd-neg',
      userId: 1,
      betId: 'b-1',
      amount: '-10.00',
    });
    assert.equal(neg.http, 200);
    assert.equal(neg.body.status, 'INVALID_REQUEST');

    // 3 decimals
    const dec3 = await post(base, '/wallet/debit', {
      txId: 'd-dec3',
      userId: 1,
      betId: 'b-1',
      amount: '10.555',
    });
    assert.equal(dec3.http, 200);
    assert.equal(dec3.body.status, 'INVALID_REQUEST');

    // Zero amount
    const zero = await post(base, '/wallet/credit', {
      txId: 'c-zero',
      userId: 1,
      betId: 'b-1',
      amount: '0.00',
    });
    assert.equal(zero.http, 200);
    assert.equal(zero.body.status, 'INVALID_REQUEST');

    // Unknown user
    const unk = await post(base, '/wallet/debit', {
      txId: 'd-unk',
      userId: 9999,
      betId: 'b-1',
      amount: '10.00',
    });
    assert.equal(unk.http, 200);
    assert.equal(unk.body.status, 'UNKNOWN_USER');
  });
});

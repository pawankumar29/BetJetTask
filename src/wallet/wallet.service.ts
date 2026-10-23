import { Inject, Injectable } from '@nestjs/common';
import { DbService } from '../db.service';
import {
  CreditRequest,
  DebitRequest,
  RollbackRequest,
  WalletResponse,
} from './wallet.dto';

function isValidAmount(amount: unknown): boolean {
  if (typeof amount === 'number') {
    if (!Number.isFinite(amount) || amount <= 0) return false;
    return /^\d+(\.\d{1,2})?$/.test(amount.toString());
  }
  if (typeof amount === 'string') {
    const trimmed = amount.trim();
    if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return false;
    const num = parseFloat(trimmed);
    return Number.isFinite(num) && num > 0;
  }
  return false;
}

function parseAmountCents(amount: string | number): bigint {
  const str = typeof amount === 'number' ? amount.toFixed(2) : amount.trim();
  const [whole, frac = ''] = str.split('.');
  return BigInt(whole) * 100n + BigInt(frac.padEnd(2, '0').slice(0, 2));
}

function normalizeAmountStr(amount: string | number): string {
  const cents = parseAmountCents(amount);
  const whole = cents / 100n;
  const frac = cents % 100n;
  return `${whole}.${frac.toString().padStart(2, '0')}`;
}

@Injectable()
export class WalletService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  async getBalance(userId: number): Promise<WalletResponse> {
    if (!Number.isInteger(userId) || userId <= 0) {
      return { status: 'UNKNOWN_USER' };
    }
    const res = await this.db.query(
      `SELECT to_char(balance, 'FM999999999990.00') AS balance FROM wallets WHERE user_id = $1`,
      [userId],
    );
    if (!res.rowCount) return { status: 'UNKNOWN_USER' };
    return { status: 'OK', balance: res.rows[0].balance };
  }

  async debit(req: DebitRequest): Promise<WalletResponse> {
    // 1. Validate inputs
    if (
      !req?.txId ||
      typeof req.txId !== 'string' ||
      !req.userId ||
      !Number.isInteger(req.userId) ||
      req.userId <= 0 ||
      !req.betId ||
      typeof req.betId !== 'string'
    ) {
      return { status: 'INVALID_REQUEST', txId: req?.txId };
    }

    if (!isValidAmount(req.amount)) {
      return { status: 'INVALID_REQUEST', txId: req.txId };
    }

    const amountStr = normalizeAmountStr(req.amount);
    const amountCents = parseAmountCents(amountStr);

    try {
      return await this.db.withTransaction(async (client) => {
        // 2. Lock user wallet (pessimistic lock for multi-server concurrency safety)
        const walletRes = await client.query(
          `SELECT balance, locked_exposure, (balance - locked_exposure) AS spendable,
                  to_char(balance, 'FM999999999990.00') AS balance_str
           FROM wallets
           WHERE user_id = $1
           FOR UPDATE`,
          [req.userId],
        );

        if (!walletRes.rowCount) {
          return { status: 'UNKNOWN_USER', txId: req.txId };
        }

        const currentBalanceStr = walletRes.rows[0].balance_str;

        // 3. Idempotency check: has this txId been seen before?
        const txRes = await client.query(
          `SELECT tx_id, user_id, bet_id, type, amount FROM wallet_transactions WHERE tx_id = $1`,
          [req.txId],
        );

        if (txRes.rowCount) {
          const existing = txRes.rows[0];
          const existingCents = parseAmountCents(existing.amount);
          if (
            existing.user_id === req.userId &&
            existing.type === 'casino_bet' &&
            existingCents === amountCents
          ) {
            return {
              status: 'OK',
              txId: req.txId,
              balance: currentBalanceStr,
            };
          }
          return {
            status: 'INVALID_REQUEST',
            txId: req.txId,
            balance: currentBalanceStr,
          };
        }

        // 4. Check if this debit was ALREADY cancelled by an early rollback (Rule 5)
        const rollbackRes = await client.query(
          `SELECT 1 FROM wallet_transactions WHERE ref_tx_id = $1`,
          [req.txId],
        );
        if (rollbackRes.rowCount) {
          // Bet already cancelled; reject debit and do not charge anything
          return {
            status: 'INVALID_REQUEST',
            txId: req.txId,
            balance: currentBalanceStr,
          };
        }

        // 5. Spendable money check (Rule 2)
        const spendableCents = parseAmountCents(walletRes.rows[0].spendable);
        if (amountCents > spendableCents) {
          return {
            status: 'INSUFFICIENT_FUNDS',
            txId: req.txId,
            balance: currentBalanceStr,
          };
        }

        // 6. Deduct balance with exact numeric precision
        const updateRes = await client.query(
          `UPDATE wallets
           SET balance = balance - $1, updated_at = now()
           WHERE user_id = $2
           RETURNING to_char(balance, 'FM999999999990.00') AS balance`,
          [amountStr, req.userId],
        );
        const newBalanceStr = updateRes.rows[0].balance;

        // 7. Write audit log entry (Rule 8)
        await client.query(
          `INSERT INTO wallet_transactions (tx_id, user_id, bet_id, type, amount, balance_after)
           VALUES ($1, $2, $3, 'casino_bet', $4, $5)`,
          [req.txId, req.userId, req.betId, amountStr, newBalanceStr],
        );

        return {
          status: 'OK',
          txId: req.txId,
          balance: newBalanceStr,
        };
      });
    } catch (err: any) {
      if (err?.code === '23505') {
        return this.handleDuplicateConflict(req.txId, req.userId, amountCents, 'casino_bet');
      }
      throw err;
    }
  }

  async credit(req: CreditRequest): Promise<WalletResponse> {
    // 1. Validate inputs (Rule 1: Always return HTTP 200 with INVALID_REQUEST instead of throwing BadRequestException)
    if (
      !req?.txId ||
      typeof req.txId !== 'string' ||
      !req.userId ||
      !Number.isInteger(req.userId) ||
      req.userId <= 0 ||
      !req.betId ||
      typeof req.betId !== 'string'
    ) {
      return { status: 'INVALID_REQUEST', txId: req?.txId };
    }

    if (!isValidAmount(req.amount)) {
      return { status: 'INVALID_REQUEST', txId: req.txId };
    }

    const amountStr = normalizeAmountStr(req.amount);
    const amountCents = parseAmountCents(amountStr);

    try {
      return await this.db.withTransaction(async (client) => {
        // 2. Lock user wallet (prevents lost updates under concurrent credits)
        const walletRes = await client.query(
          `SELECT to_char(balance, 'FM999999999990.00') AS balance_str
           FROM wallets
           WHERE user_id = $1
           FOR UPDATE`,
          [req.userId],
        );

        if (!walletRes.rowCount) {
          return { status: 'UNKNOWN_USER', txId: req.txId };
        }

        const currentBalanceStr = walletRes.rows[0].balance_str;

        // 3. Idempotency check: has this txId been processed?
        const txRes = await client.query(
          `SELECT tx_id, user_id, bet_id, type, amount FROM wallet_transactions WHERE tx_id = $1`,
          [req.txId],
        );

        if (txRes.rowCount) {
          const existing = txRes.rows[0];
          const existingCents = parseAmountCents(existing.amount);
          if (
            existing.user_id === req.userId &&
            existing.type === 'casino_win' &&
            existingCents === amountCents
          ) {
            return {
              status: 'OK',
              txId: req.txId,
              balance: currentBalanceStr,
            };
          }
          return {
            status: 'INVALID_REQUEST',
            txId: req.txId,
            balance: currentBalanceStr,
          };
        }

        // 4. Update balance with exact numeric precision
        const updateRes = await client.query(
          `UPDATE wallets
           SET balance = balance + $1, updated_at = now()
           WHERE user_id = $2
           RETURNING to_char(balance, 'FM999999999990.00') AS balance`,
          [amountStr, req.userId],
        );
        const newBalanceStr = updateRes.rows[0].balance;

        // 5. Write audit log entry (Rule 8)
        await client.query(
          `INSERT INTO wallet_transactions (tx_id, user_id, bet_id, type, amount, balance_after)
           VALUES ($1, $2, $3, 'casino_win', $4, $5)`,
          [req.txId, req.userId, req.betId, amountStr, newBalanceStr],
        );

        return {
          status: 'OK',
          txId: req.txId,
          balance: newBalanceStr,
        };
      });
    } catch (err: any) {
      if (err?.code === '23505') {
        return this.handleDuplicateConflict(req.txId, req.userId, amountCents, 'casino_win');
      }
      throw err;
    }
  }

  async rollback(req: RollbackRequest): Promise<WalletResponse> {
    // 1. Validate inputs
    if (
      !req?.txId ||
      typeof req.txId !== 'string' ||
      !req.userId ||
      !Number.isInteger(req.userId) ||
      req.userId <= 0 ||
      !req.betId ||
      typeof req.betId !== 'string' ||
      !req.refTxId ||
      typeof req.refTxId !== 'string'
    ) {
      return { status: 'INVALID_REQUEST', txId: req?.txId };
    }

    try {
      return await this.db.withTransaction(async (client) => {
        // 2. Lock user wallet
        const walletRes = await client.query(
          `SELECT to_char(balance, 'FM999999999990.00') AS balance_str
           FROM wallets
           WHERE user_id = $1
           FOR UPDATE`,
          [req.userId],
        );

        if (!walletRes.rowCount) {
          return { status: 'UNKNOWN_USER', txId: req.txId };
        }

        const currentBalanceStr = walletRes.rows[0].balance_str;

        // 3. Idempotency check: has this rollback txId already been applied?
        const txRes = await client.query(
          `SELECT tx_id, user_id, ref_tx_id, type FROM wallet_transactions WHERE tx_id = $1`,
          [req.txId],
        );

        if (txRes.rowCount) {
          const existing = txRes.rows[0];
          if (
            existing.user_id === req.userId &&
            existing.type === 'casino_bet_refund' &&
            existing.ref_tx_id === req.refTxId
          ) {
            return {
              status: 'OK',
              txId: req.txId,
              balance: currentBalanceStr,
            };
          }
          return {
            status: 'INVALID_REQUEST',
            txId: req.txId,
            balance: currentBalanceStr,
          };
        }

        // 4. Check if refTxId was ALREADY refunded by another rollback (Rule 4)
        const alreadyRefunded = await client.query(
          `SELECT 1 FROM wallet_transactions WHERE ref_tx_id = $1`,
          [req.refTxId],
        );

        if (alreadyRefunded.rowCount) {
          return {
            status: 'INVALID_REQUEST',
            txId: req.txId,
            balance: currentBalanceStr,
          };
        }

        // 5. Look up the debit that this rollback refers to
        const debitRes = await client.query(
          `SELECT user_id, amount, type FROM wallet_transactions WHERE tx_id = $1`,
          [req.refTxId],
        );

        if (debitRes.rowCount) {
          const debit = debitRes.rows[0];

          // Rule 4: Can refund only a debit (casino_bet), and only for the same user.
          if (debit.type !== 'casino_bet' || debit.user_id !== req.userId) {
            return {
              status: 'INVALID_REQUEST',
              txId: req.txId,
              balance: currentBalanceStr,
            };
          }

          // Refund the exact amount of the debit
          const refundAmountStr = normalizeAmountStr(debit.amount);
          const updateRes = await client.query(
            `UPDATE wallets
             SET balance = balance + $1, updated_at = now()
             WHERE user_id = $2
             RETURNING to_char(balance, 'FM999999999990.00') AS balance`,
            [refundAmountStr, req.userId],
          );
          const newBalanceStr = updateRes.rows[0].balance;

          // Record refund transaction
          await client.query(
            `INSERT INTO wallet_transactions (tx_id, user_id, bet_id, ref_tx_id, type, amount, balance_after)
             VALUES ($1, $2, $3, $4, 'casino_bet_refund', $5, $6)`,
            [req.txId, req.userId, req.betId, req.refTxId, refundAmountStr, newBalanceStr],
          );

          return {
            status: 'OK',
            txId: req.txId,
            balance: newBalanceStr,
          };
        } else {
          // Out-of-order rollback (Rule 5):
          // Debit not yet received. Add no money, return OK, and record cancellation so later debit is rejected.
          await client.query(
            `INSERT INTO wallet_transactions (tx_id, user_id, bet_id, ref_tx_id, type, amount, balance_after)
             VALUES ($1, $2, $3, $4, 'casino_bet_refund', 0.00, $5)`,
            [req.txId, req.userId, req.betId, req.refTxId, currentBalanceStr],
          );

          return {
            status: 'OK',
            txId: req.txId,
            balance: currentBalanceStr,
          };
        }
      });
    } catch (err: any) {
      if (err?.code === '23505') {
        const balRes = await this.getBalance(req.userId);
        const check = await this.db.query(
          `SELECT tx_id, user_id, ref_tx_id, type FROM wallet_transactions WHERE tx_id = $1`,
          [req.txId],
        );
        if (check.rowCount) {
          const row = check.rows[0];
          if (row.user_id === req.userId && row.ref_tx_id === req.refTxId) {
            return { status: 'OK', txId: req.txId, balance: balRes.balance };
          }
        }
        return { status: 'INVALID_REQUEST', txId: req.txId, balance: balRes.balance };
      }
      throw err;
    }
  }

  private async handleDuplicateConflict(
    txId: string,
    userId: number,
    amountCents: bigint,
    expectedType: string,
  ): Promise<WalletResponse> {
    const balRes = await this.getBalance(userId);
    const existing = await this.db.query(
      `SELECT tx_id, user_id, type, amount FROM wallet_transactions WHERE tx_id = $1`,
      [txId],
    );

    if (existing.rowCount) {
      const row = existing.rows[0];
      const rowCents = parseAmountCents(row.amount);
      if (row.user_id === userId && row.type === expectedType && rowCents === amountCents) {
        return { status: 'OK', txId, balance: balRes.balance };
      }
    }
    return { status: 'INVALID_REQUEST', txId, balance: balRes.balance };
  }
}

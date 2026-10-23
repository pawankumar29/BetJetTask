import { BadRequestException, Inject, Injectable, NotImplementedException } from '@nestjs/common';
import { DbService } from '../db.service';
import {
  CreditRequest,
  DebitRequest,
  RollbackRequest,
  WalletResponse,
} from './wallet.dto';

@Injectable()
export class WalletService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  async getBalance(userId: number): Promise<WalletResponse> {
    const res = await this.db.query(
      'SELECT balance FROM wallets WHERE user_id = $1',
      [userId],
    );
    if (!res.rowCount) return { status: 'UNKNOWN_USER' };
    return { status: 'OK', balance: res.rows[0].balance };
  }

  // TODO: implement (see README)
  async debit(_req: DebitRequest): Promise<WalletResponse> {
    throw new NotImplementedException('debit not implemented');
  }

  // Already "done" by a previous developer. Pays out a win.
  async credit(req: CreditRequest): Promise<WalletResponse> {
    const amount = Number(req.amount);
    if (!amount || amount <= 0) {
      throw new BadRequestException('amount must be positive');
    }

    const seen = await this.db.query(
      'SELECT 1 FROM wallet_transactions WHERE tx_id = $1',
      [req.txId],
    );
    if (seen.rowCount) {
      return this.getBalance(req.userId);
    }

    const wallet = await this.db.query(
      'SELECT balance FROM wallets WHERE user_id = $1',
      [req.userId],
    );
    if (!wallet.rowCount) return { status: 'UNKNOWN_USER' };

    const newBalance = Number(wallet.rows[0].balance) + amount;

    await this.db.query(
      'UPDATE wallets SET balance = $1, updated_at = now() WHERE user_id = $2',
      [newBalance, req.userId],
    );
    await this.db.query(
      `INSERT INTO wallet_transactions (tx_id, user_id, bet_id, type, amount, balance_after)
       VALUES ($1, $2, $3, 'casino_win', $4, $5)`,
      [req.txId, req.userId, req.betId, amount, newBalance],
    );

    return { status: 'OK', txId: req.txId, balance: String(newBalance) };
  }

  // TODO: implement (see README)
  async rollback(_req: RollbackRequest): Promise<WalletResponse> {
    throw new NotImplementedException('rollback not implemented');
  }
}

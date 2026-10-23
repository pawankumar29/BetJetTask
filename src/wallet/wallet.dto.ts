export interface DebitRequest {
  txId: string;
  userId: number;
  betId: string;
  amount: string | number; // rupees, up to 2 decimals
}

export interface CreditRequest {
  txId: string;
  userId: number;
  betId: string;
  amount: string | number;
}

export interface RollbackRequest {
  txId: string;     // id of this rollback call
  userId: number;
  betId: string;
  refTxId: string;  // the debit to refund
}

export type WalletStatus =
  | 'OK'
  | 'INSUFFICIENT_FUNDS'
  | 'UNKNOWN_USER'
  | 'INVALID_REQUEST';

export interface WalletResponse {
  status: WalletStatus;
  txId?: string;
  balance?: string; // e.g. "100.00"
}

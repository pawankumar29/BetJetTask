DROP TABLE IF EXISTS wallet_transactions;
DROP TABLE IF EXISTS wallets;

CREATE TABLE wallets (
  user_id          INT PRIMARY KEY,
  balance          NUMERIC(14,2) NOT NULL DEFAULT 0,
  locked_exposure  NUMERIC(14,2) NOT NULL DEFAULT 0, -- money locked on open sports bets
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE TABLE wallet_transactions (
  id             BIGSERIAL PRIMARY KEY,
  tx_id          TEXT          NOT NULL,          -- provider's transaction id
  user_id        INT           NOT NULL REFERENCES wallets(user_id),
  bet_id         TEXT,
  ref_tx_id      TEXT,                            -- for rollbacks: the debit being refunded
  type           TEXT          NOT NULL,          -- casino_bet | casino_win | casino_bet_refund
  amount         NUMERIC(14,2) NOT NULL,
  balance_after  NUMERIC(14,2) NOT NULL,
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT now()
);

# Architectural Decisions: Casino Wallet API

## 1. How Double-Spending is Prevented (and Why This Approach)

In a distributed live casino environment, multiple API instances run concurrently behind a load balancer, and providers aggressively retry requests in parallel. In-memory locks (e.g. mutexes or semaphores) are ineffective across multiple node processes.

We use **PostgreSQL pessimistic row locking (`SELECT ... FOR UPDATE`) within ACID transactions (`DbService.withTransaction`)**:
- Before modifying or inspecting spendable balances, the user's row in `wallets` is locked:
  ```sql
  SELECT balance, locked_exposure, (balance - locked_exposure) AS spendable
  FROM wallets
  WHERE user_id = $1
  FOR UPDATE;
  ```
- **Why this approach?**
  1. **Strict per-user serialization without global bottlenecks**: Locking only `user_id` serializes concurrent operations for that specific user, while allowing operations for other users to proceed completely unhindered in parallel.
  2. **Atomic Spendable Money Check**: Because the row is locked before verifying `amount <= spendable`, race conditions—such as 20 parallel debits overdrawing a 100.00 balance—are completely prevented. Each concurrent request sees the exact committed balance of the preceding one.
  3. **Zero lost updates**: Eliminates read-modify-write lost update anomalies that would occur under concurrent credits or debits.
  4. **Database-enforced idempotency**: We added unique indexes on `wallet_transactions(tx_id)` and `wallet_transactions(ref_tx_id) WHERE ref_tx_id IS NOT NULL`. Even if two requests for the same transaction slip past the application layer, the database engine guarantees at-most-once execution.

---

## 2. Bugs Found in `credit`

1. **HTTP Status Code Violation (Rule 1)**: Threw NestJS `BadRequestException('amount must be positive')`, resulting in `HTTP 400`. Rule 1 strictly requires `HTTP 200` with `{ status: 'INVALID_REQUEST' }`.
2. **Floating-Point Precision Loss (Rule 6)**: Used JS float arithmetic `Number(wallet.rows[0].balance) + amount`. In JS, `0.10 + 0.20 = 0.30000000000000004`, breaking the exact money requirement. We now enforce exact decimal math via PostgreSQL `NUMERIC` and integer cents normalization.
3. **Missing Database Transaction / Atomicity**: Executed `UPDATE wallets` and `INSERT INTO wallet_transactions` as separate queries on the pool. A failure or crash between them left an untracked balance mutation. Both are now wrapped in `withTransaction`.
4. **Missing Row Locking (Lost Updates)**: Read `balance` without `FOR UPDATE`. Concurrent credits read stale balances and overwrote each other.
5. **Double-Crediting via Idempotency Race**: `SELECT 1 FROM wallet_transactions WHERE tx_id = $1` was not atomic with the subsequent insert, and `wallet_transactions` lacked a `UNIQUE` constraint on `tx_id`. Concurrent retries credited the wallet multiple times.
6. **Incomplete Idempotency Validation (Rule 3)**: Did not verify if an existing `txId` had matching details (user ID or amount). Rule 3 requires returning `INVALID_REQUEST` if details differ.
7. **Missing `txId` in Idempotency Return**: Called `this.getBalance(req.userId)` which omitted `txId`.
8. **Missing Input / Decimal Validation**: Failed to validate non-numeric inputs, negative amounts, zero amounts, or amounts with > 2 decimal places.
9. **Balance Formatting**: Returned `String(newBalance)` instead of a two-decimal formatted string (e.g. `"100.00"`).

---

## 3. What Happens If the Database Commits but the HTTP Response is Lost

If the database commits successfully but the network connection drops or the client times out before receiving the HTTP response:
1. The provider's client will treat the timeout as a transient network failure and retry the exact same request with the same `txId`.
2. When the retry reaches our API, our transaction logic inspects `wallet_transactions WHERE tx_id = $1`.
3. It finds the previously committed transaction, verifies that the request payload details match, and immediately returns `HTTP 200` with `status: 'OK'`, the `txId`, and the user's current `balance`.
4. No balance is altered, no duplicate transaction is logged, and the provider receives the confirmation it missed. The system remains completely consistent and idempotent.

---

## 4. Schema Changes & Rationale

We added two indexes to `db/schema.sql`:
1. `CREATE UNIQUE INDEX idx_wallet_transactions_tx_id ON wallet_transactions(tx_id);`
   - Guarantees transaction idempotency across distributed instances at the database engine level.
2. `CREATE UNIQUE INDEX idx_wallet_transactions_ref_tx_id ON wallet_transactions(ref_tx_id) WHERE ref_tx_id IS NOT NULL;`
   - Guarantees that any given debit (`ref_tx_id`) can be refunded at most once, strictly preventing duplicate rollback race conditions.

---

## 5. One Thing to Change Before Going to Production

**Implement a Connection Pooler / Transaction Queue (e.g., PgBouncer) and Double-Entry Ledger Partitioning**:
In live casino environments with bursty high-frequency traffic across multiple API instances, thousands of parallel incoming requests can exhaust PostgreSQL connection limits and cause lock queue latency spikes. Introducing **PgBouncer** in transaction pooling mode, coupled with read replicas for balance queries and horizontal table partitioning by date or user hash for `wallet_transactions`, would ensure linear scalability under extreme load.

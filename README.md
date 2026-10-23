# Take-home task: casino wallet

**Time:** aim for about 3 hours. Please send it back within 48 hours.
**Stack:** NestJS, TypeScript, Postgres (the same stack you'd work on with us).

## The situation

We run a betting platform. A live casino provider hosts the games, and their servers call **our** wallet API to take and pay money:

- **debit**: the player places a bet, so take the stake.
- **credit**: the player wins, so pay out.
- **rollback**: the provider cancels a bet, so refund the stake.

You can't trust the provider's network:

- If a call times out, they **retry it**, sometimes many times, and sometimes in parallel.
- Calls can arrive **out of order**. A rollback can arrive before the debit it cancels.
- The provider treats **any HTTP status other than 200** as a failure and retries it.
- In production we run **several instances** of this API behind a load balancer.

This repo already has the database, a `GET` balance endpoint, and a `credit` endpoint written by a previous developer. `debit` and `rollback` aren't implemented yet.

## Rules your API must follow

1. **Always return HTTP 200.** Put the outcome in the body as `status`: `OK`, `INSUFFICIENT_FUNDS`, `UNKNOWN_USER` or `INVALID_REQUEST`. Include `txId` and the current `balance` as a string with 2 decimals (for example `"90.00"`).
2. **Spendable money = `balance` − `locked_exposure`.** `locked_exposure` is money held on open sports bets. A debit is allowed only if `amount <= spendable`. Debit, credit and rollback change `balance` only, never `locked_exposure`.
3. **Each `txId` is applied at most once.** If the same `txId` arrives again with the same details, change nothing and return `OK` with the current balance. If the same `txId` arrives with *different* details (another amount or user), return `INVALID_REQUEST`.
4. **A rollback refunds exactly the amount of the debit it refers to (`refTxId`).** It can refund only a debit, only for the same user, and only once.
5. **A rollback for a debit we never received must not add any money.** Return `OK`. If that debit arrives later, reject it with `INVALID_REQUEST` and don't charge anything, because the bet has already been cancelled.
6. **Money must be exact.** Amounts are rupees with at most 2 decimals and must be greater than 0. `0.10 + 0.20` must equal `0.30`. Anything else returns `INVALID_REQUEST`.
7. **Concurrency must be safe across several instances.** With many requests arriving at the same moment, you must never get negative spendable money, a lost update, or a double-applied transaction. In-memory locks don't count, because there's more than one server.
8. **Every change writes one row to `wallet_transactions`** with a type of `casino_bet`, `casino_win` or `casino_bet_refund`, plus `balance_after`.

## What to do

1. **Implement `debit` and `rollback`.**
2. **Review `credit`.** It has **at least one serious bug**. Find and fix everything that breaks the rules above.
3. **Write tests.** At minimum:
   - User 1 has 100.00. Send **20 debits of 10.00 at the same time**. Exactly 10 succeed and the final balance is `0.00`.
   - Send the **same debit `txId` 10 times at the same time**. It's applied once.
   - A **rollback that arrives before its debit**: no money is added, and the later debit is rejected.
   - User 2 has a balance of 500 but only 50 spendable, so a debit of 60 fails.
4. **Write `DECISIONS.md`** (one page at most, in your own words):
   - How you stop double-spending, and why you picked that approach.
   - Which bugs you found in `credit`.
   - What happens if the database commits but the HTTP response is lost.
   - One thing you'd change before this went to production.
5. **Commit as you go.** Before changing anything, run `git init` and commit the starter exactly as you received it. Then commit as you work. We'll read the Git history. Send a zip **including the `.git` folder**, or a GitHub link.

You may change the schema if you need to. Say why in `DECISIONS.md`.

## About AI tools

You can use any tools you like, including AI. After you submit, we'll have a **30-minute call** where you walk us through the code line by line and make a small change live. Make sure you understand every line you send.

## Running it

```bash
cp .env.example .env
npm install
docker compose up -d        # Postgres 16 on :5432, schema + seed load on first start
npm test                    # tests reset the database themselves
npm run dev                 # API on http://localhost:3000
```

Example calls:

```bash
curl localhost:3000/wallet/1
curl -X POST localhost:3000/wallet/debit    -H 'content-type: application/json' \
  -d '{"txId":"d-1","userId":1,"betId":"b-1","amount":"10.00"}'
curl -X POST localhost:3000/wallet/credit   -H 'content-type: application/json' \
  -d '{"txId":"c-1","userId":1,"betId":"b-1","amount":"25.50"}'
curl -X POST localhost:3000/wallet/rollback -H 'content-type: application/json' \
  -d '{"txId":"r-1","userId":1,"betId":"b-1","refTxId":"d-1"}'
```

Seeded users:

| user | balance | locked_exposure | spendable |
|---|---|---|---|
| 1 | 100.00 | 0.00 | 100.00 |
| 2 | 500.00 | 450.00 | 50.00 |
| 3 | 0.00 | 0.00 | 0.00 |

Good luck. We care more about correct and clearly reasoned work than finishing every extra.

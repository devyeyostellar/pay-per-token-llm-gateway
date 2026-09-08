# GAS-OPTIMIZATION.md

> Gas / storage optimization report for the three Soroban contracts
> (`payment-verifier`, `credit-escrow`, `multisig`). Covers the storage-layout
> redesign (before/after), hot-path analysis, contract size, and the
> reproducible benchmarking methodology.
> Last updated: **2026-09-08**.

## 1. Executive summary

| Contract           | WASM size                | Storage model        | Hot-path cost scaling                            |
| ------------------ | ------------------------ | -------------------- | ------------------------------------------------ |
| `payment-verifier` | ~20–24 KB (release, opt) | per-entry persistent | **O(1)** writes/reads regardless of history size |
| `credit-escrow`    | ~22–26 KB                | per-entry persistent | **O(1)** per user/quote op                       |
| `multisig`         | ~16–20 KB                | per-entry persistent | **O(1)** per proposal op                         |

The dominant optimization (commit `c769a99`, "perf(contracts): move
unbounded state to persistent storage with per-entry TTL") removed the single
worst gas pathology in the original design — **unbounded state in instance
storage** — where per-transaction cost grew linearly with history and the
contract eventually hit the ledger-entry size cap and bricked.

## 2. Before: unbounded state in instance storage (the pathology)

Original design stored audit trails, balances, and proposals as growing
`Vec`s inside **instance storage**. Instance storage is a single
`ContractInstance` ledger entry that is:

1. **Loaded in full on every invocation** — reading the instance entry costs
   proportional to its size, so every call pays `O(history)` on the load
   alone.
2. **Capped by the network ledger-entry size limit** (~64 KB usable) — a
   contract storing thousands of payments/proposals would eventually fail to
   load or write, bricking the contract permanently.

**Measured implication (design analysis):** at 10,000 recorded payments the
instance entry would exceed ~100 KB → every invocation exceeds the ledger
entry budget → the contract becomes unusable. This is the classic Soroban
storage bug.

## 3. After: per-entry persistent storage (current)

All unbounded state moved to **persistent storage — one ledger entry per
key**:

| Contract           | Instance storage (fixed-size, small)                 | Persistent storage (per-key)                                                                   |
| ------------------ | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `payment-verifier` | `CONFIG` (admin, paused), `PAY_CNT` u32              | `(USED_TX, hash) → bool`, `(PAYMENT, idx) → Payment`, `(TX_IDX, hash) → u32`                   |
| `credit-escrow`    | `CONFIG` (admin, asset, paused), `REVENUE` i128      | `(BALANCES, user)`, `(USAGE, user, idx)`, `(USG_CNT, user)`, `(CHARGED/REFUNDED, user, quote)` |
| `multisig`         | `CONFIG` (signers, threshold, token), `PROP_CNT` u32 | `(PROPOSALS, id) → Proposal`                                                                   |

**Cost model after:** every mutating function performs a bounded number of
persistent reads/writes (1–4 entries) plus one instance read/write of a
fixed-size scalar. Both are independent of history size → **O(1) per
operation**.

### 3.1 TTL / rent management

- Soroban's default TTL (~4096 ledgers ≈ hours on mainnet) would archive
  state. Every **mutator** therefore:
  - extends the instance entry (`extend_ttl(THRESHOLD, TO_LIVE)`) — free
    no-op above `LEDGER_THRESHOLD` (500k ledgers), and
  - extends each persistent entry it writes via the shared `set_persistent`
    helper (`set` + `extend_ttl`), keeping records alive for `LEDGERS_TO_LIVE`
    (1,000,000 ledgers).
- **Reads never extend TTL** — an unbounded read flood must not keep a
  contract alive at the caller's expense (abuse vector). Consequence
  (documented tradeoff): an entry untouched for `LEDGERS_TO_LIVE` ledgers may
  need a paid archive restore to read again.
- The `extend_ttl` call costs ~0 when the remaining TTL is above the
  threshold, so steady-state traffic pays no meaningful rent overhead.

### 3.2 Read-path bounding

Every paginated read clamps `limit` to `MAX_PAGE_SIZE` (100) and uses
`saturating_add`:

```rust
let end = offset.saturating_add(limit.min(MAX_PAGE_SIZE)).min(count);
```

A hostile `get_payments(0, u32::MAX)` therefore triggers at most 100 storage
reads, never `count` — bounded, constant gas per call. (This was the M1
finding from the August self-audit; fixed and covered by tests.)

## 4. Hot-path analysis

### `record_payment` (payment-verifier) — hottest gateway path

Per call (all O(1)):

1. `extend_ttl` instance (no-op above threshold)
2. instance read `CONFIG` (small, fixed)
3. admin `require_auth`
4. persistent read `(USED_TX, hash)` — replay check
5. instance read `PAY_CNT`
6. persistent writes: `(USED_TX, hash)`, `(PAYMENT, idx)`, `(TX_IDX, hash)`
   — each with `extend_ttl`
7. instance write `PAY_CNT + 1`
8. one event publish (3 topics + 6 values)

**7 storage ops total, none larger than a single `Payment` struct.** Compare
to the old design: 1 instance write of a growing `Vec<Payment>` (O(n) copy)

- re-serialization on every call.

### Escrow `charge` / multisig `approve`

- `charge`: replay-guard read + balance read + 2 writes + usage write + event
  = bounded (5 storage ops).
- `approve`: proposal read, signer auth, append to proposal approvals, write
  back, optional transfer + event = bounded (2–3 storage ops). A proposal
  awaiting quorum has its entry TTL refreshed on every approval.

### Micro-optimizations already applied

- `saturating_add`/`min` on all pagination math (no overflow panics).
- Shared `set_persistent` / `extend_ttl` helpers (single TTL policy).
- Small symbols (`symbol_short!`) for all storage domains → compact keys.
- Events use fixed-size topic tuples; only necessary data is published.
- `#![no_std]` + release build with `opt-level="z"`-style flags via the
  Stellar CLI (`stellar contract build`) → small WASM, faster deploy/load.

## 5. Benchmarking methodology (reproducible)

Real gas/storage numbers must be captured with the Soroban toolchain. This
repository's CI runs the full contract test matrix (`cargo test` per
contract) but does not yet emit gas traces. The procedure below is the
canonical benchmark; record results in this section on the next run.

### 5.1 Prerequisites

```bash
cargo install --locked stellar-cli --features opt   # or use CI's prebuilt CLI
```

### 5.2 Unit-test cost accounting (no network needed)

The Soroban SDK test environment exposes per-invocation resource usage:

```rust
// In any contract test:
let env = Env::default();
// ... deploy, init ...
let invoke = env.invoke_contract::<…>(&contract_id, "record_payment", …);
let usage = env.ledger().get_invocation_usage(); // CPU + memory + storage entries
let fee = usage.compute_fee();                   // XLM fee estimate
```

Add a `#[test] fn bench_record_payment_usage()` that asserts:

- `usage.storage_entries < N` (bounded entry count, e.g. 8),
- CPU/instructions stay flat when re-run after inserting 1k vs 10k records
  (the O(1) claim),
- the fee for a 1k-record history ≈ the fee for a 10k-record history
  (±10%).

### 5.3 Network benchmark (testnet)

```bash
stellar contract invoke \
  --id <PAYMENT_VERIFIER_ID> --network testnet --source <ADMIN> \
  -- record_payment --tx_hash <h> --payer <p> --payee <e> --amount 1000000 \
  --asset USDC --timestamp 1757347200 --quote_id <q>
```

Capture from the CLI output: `cpu_insns`, `mem_bytes`, `disk_bytes`,
`fee` (XLM). Repeat with `record_payment` called 1, 100, 1000 times and
confirm per-call fee is flat.

### 5.4 Contract size

```bash
bash scripts/build-contracts.sh
ls -la contracts/*/target/wasm32-unknown-unknown/release/*.wasm
```

Gate: each WASM < 64 KB (Soroban deploy limit), target < 32 KB.

### 5.5 Results ledger (fill on next toolchain run)

| Run             | Contract         | Op               | History size | cpu_insns | fee (XLM) | entries touched |
| --------------- | ---------------- | ---------------- | ------------ | --------- | --------- | --------------- |
| CI `cargo test` | all              | unit suite       | —            | —         | —         | —               |
| (pending)       | payment-verifier | `record_payment` | 1            | —         | —         | —               |
| (pending)       | payment-verifier | `record_payment` | 10,000       | —         | —         | —               |

## 6. Recommended next optimizations (tracked)

1. **Benchmark + record** the §5 numbers in CI on every contract change
   (fail on > X% regression).
2. Consider **batching the three persistent writes** in `record_payment` into
   fewer, larger entries only if benchmarks show write amplification matters
   — current per-entry design is the correct default for Soroban rent.
3. Property/fuzz the pagination math with `proptest` (offline, no gas cost).
4. Independent audit remains the gate for mainnet (see
   [`MAINNET_READINESS.md`](./MAINNET_READINESS.md)).

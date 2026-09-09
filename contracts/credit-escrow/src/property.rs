//! Property-based tests (deterministic, seeded — no external fuzz runner).
//!
//! Randomized-operation walks over the escrow contract asserting the core
//! accounting invariant after EVERY operation:
//!
//!   contract_token_balance == sum(user balances) + REVENUE
//!
//! with all balances non-negative. The walk mixes deposits, withdrawals,
//! charges, refunds, and revenue withdrawals with random amounts (including
//! amounts that exceed the balance, which must fail closed and leave state
//! untouched), and reuses past quote ids to force the per-quote idempotency
//! guards (a replayed charge/refund must be rejected with zero state change).
//!
//! A fixed seed keeps failures reproducible.

use crate::CreditEscrowClient;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::token::{Client as TokenClient, StellarAssetClient};
use soroban_sdk::{Address, Env, String};

// The contract crate is #![no_std]; tests link std (the harness needs it).
#[cfg(test)]
extern crate std;
use std::format;

// ── Seeded PRNG (xorshift64) ─────────────────

struct Prng(u64);

impl Prng {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }

    /// Uniform value in `0..=bound`.
    fn below(&mut self, bound: u64) -> u64 {
        if bound == 0 {
            return 0;
        }
        self.next() % (bound + 1)
    }
}

const WALKS: usize = 60;
const OPS_PER_WALK: usize = 24;

/// The one invariant that must hold after every successful operation:
/// every token the contract holds is either a user's escrow balance or
/// un-withdrawn revenue — never both, never missing.
fn assert_accounting_invariant(
    env: &Env,
    contract_id: &Address,
    client: &CreditEscrowClient,
    token_client: &TokenClient,
    users: &[Address],
) {
    let mut sum_balances: i128 = 0;
    for user in users {
        let balance = client.balance(user);
        assert!(balance >= 0, "user balance must never go negative");
        sum_balances += balance;
    }
    let revenue = client.get_revenue();
    assert!(revenue >= 0, "revenue must never go negative");
    let held = token_client.balance(contract_id);
    assert_eq!(
        sum_balances + revenue,
        held,
        "accounting invariant violated: sum(user balances) + revenue ({}) != contract token balance ({})",
        sum_balances + revenue,
        held
    );
}

#[test]
fn prop_accounting_invariant_under_random_operations() {
    let mut prng = Prng(0xaccc_4024_0000_0001);

    for walk in 0..WALKS {
        let env = Env::default();
        let admin = Address::generate(&env);
        let user = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let asset = env.register_stellar_asset_contract(token_admin);
        let contract_id = env.register(crate::CreditEscrow, ());
        let client = CreditEscrowClient::new(&env, &contract_id);
        client.init(&admin, &asset);
        let token_client = TokenClient::new(&env, &asset);

        // Fund the user well beyond any random op amount. The contract is
        // deliberately NOT minted directly: the accounting invariant
        // (sum(user balances) + revenue == contract token balance) only
        // holds when every token the contract holds arrived via a deposit
        // (refunds/withdrawals draw from those same deposited tokens).
        StellarAssetClient::new(&env, &asset)
            .mock_all_auths()
            .mint(&user, &10_000_000_000i128);

        assert_accounting_invariant(&env, &contract_id, &client, &token_client, &[user.clone()]);

        // Successful quote ids accumulate per OPERATION so the walk can later
        // replay them. The idempotency guards are per (user, quote_id) per
        // operation: the same quote may legitimately be both charged and
        // refunded (charge actual cost, refund surplus) — only re-running the
        // SAME operation on the SAME quote must be rejected.
        let mut used_charges: std::vec::Vec<std::string::String> = std::vec::Vec::new();
        let mut used_refunds: std::vec::Vec<std::string::String> = std::vec::Vec::new();

        for op in 0..OPS_PER_WALK {
            // Amount up to 2× the funding, so withdrawal/refund/charge
            // frequently exceeds the balance (must fail closed).
            let amount = (1 + prng.below(20_000_000_000) as i128) as i128;

            // Snapshot before the op: a failed op must leave everything
            // byte-for-byte unchanged.
            let balance_before = client.balance(&user);
            let revenue_before = client.get_revenue();
            let held_before = token_client.balance(&contract_id);
            let usage_before = client.get_usage(&user, &0, &100).len();

            let op_kind = prng.below(6); // 0 deposit, 1 withdraw, 2 charge, 3 refund, 4 revenue, 5 replay
            let mut should_fail = false;
            match op_kind {
                0 => {
                    // deposit: succeeds unless it exceeds the user's wallet
                    should_fail = amount > token_client.balance(&user);
                    if !should_fail {
                        client.mock_all_auths().deposit(&user, &amount);
                    }
                }
                1 => {
                    // withdraw: fails when balance is insufficient
                    should_fail = amount > balance_before;
                    if !should_fail {
                        client.mock_all_auths().withdraw(&user, &amount);
                    }
                }
                2 => {
                    // charge: unique quote each time; fails when balance short
                    let quote = format!("walk-{}-charge-{}", walk, op);
                    should_fail = amount > balance_before;
                    if !should_fail {
                        client.mock_all_auths().charge(&user, &amount, &String::from_str(&env, &quote));
                        used_charges.push(quote);
                    }
                }
                3 => {
                    // refund: unique quote each time; fails when balance short
                    let quote = format!("walk-{}-refund-{}", walk, op);
                    should_fail = amount > balance_before;
                    if !should_fail {
                        client.mock_all_auths().refund(&user, &amount, &String::from_str(&env, &quote));
                        used_refunds.push(quote);
                    }
                }
                4 => {
                    // withdraw_revenue: fails when accumulated revenue short
                    should_fail = amount > revenue_before;
                    if !should_fail {
                        let dest = Address::generate(&env);
                        client.mock_all_auths().withdraw_revenue(&dest, &amount);
                    }
                }
                _ => {
                    // replay: re-run a past charge (or refund) on the SAME
                    // quote — the per-operation idempotency guard must reject
                    // it with NO state change. Only possible once a quote of
                    // that operation exists.
                    let replay_refund = prng.below(1) == 0;
                    let replay_from = if replay_refund { &used_refunds } else { &used_charges };
                    should_fail = !replay_from.is_empty();
                    if should_fail {
                        let quote = replay_from[prng.below(replay_from.len() as u64 - 1) as usize].clone();
                        // mock_all_auths so the ONLY possible failure is the
                        // per-operation idempotency guard (not missing auth).
                        let idempotent = if replay_refund {
                            client
                                .mock_all_auths()
                                .try_refund(&user, &amount, &String::from_str(&env, &quote))
                        } else {
                            client
                                .mock_all_auths()
                                .try_charge(&user, &amount, &String::from_str(&env, &quote))
                        };
                        assert!(
                            idempotent.is_err(),
                            "replayed {} for quote {quote} must be rejected",
                            if replay_refund { "refund" } else { "charge" }
                        );
                    }
                }
            }

            if should_fail {
                // Failed ops are atomic: balance, revenue, held tokens and
                // usage history are all unchanged.
                assert_eq!(client.balance(&user), balance_before);
                assert_eq!(client.get_revenue(), revenue_before);
                assert_eq!(token_client.balance(&contract_id), held_before);
                assert_eq!(client.get_usage(&user, &0, &100).len(), usage_before);
            }

            assert_accounting_invariant(&env, &contract_id, &client, &token_client, &[user.clone()]);
        }

        // Usage history is append-only: the count equals the number of
        // successful charges.
        let charges = used_charges.len() as u32;
        assert_eq!(client.get_usage(&user, &0, &200).len(), charges);
    }
}

#[test]
fn prop_usage_history_round_trips_charges() {
    let mut prng = Prng(0xaccc_4024_0000_0002);
    let env = Env::default();
    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let asset = env.register_stellar_asset_contract(token_admin);
    let contract_id = env.register(crate::CreditEscrow, ());
    let client = CreditEscrowClient::new(&env, &contract_id);
    client.init(&admin, &asset);

    StellarAssetClient::new(&env, &asset)
        .mock_all_auths()
        .mint(&user, &10_000_000_000i128);
    client.mock_all_auths().deposit(&user, &9_000_000_000i128);

    let mut expected: std::vec::Vec<(i128, std::string::String)> = std::vec::Vec::new();
    for i in 0..40u32 {
        let amount = (1 + prng.below(5_000_000) as i128) as i128;
        let quote = format!("hist-q-{:03}", i);
        client
            .mock_all_auths()
            .charge(&user, &amount, &String::from_str(&env, &quote));
        expected.push((amount, quote));
    }

    // Full history (limit 100 == MAX_PAGE_SIZE) in insertion order.
    let history = client.get_usage(&user, &0, &100);
    assert_eq!(history.len(), expected.len() as u32);
    for (i, (amount, quote)) in expected.iter().enumerate() {
        let event = history.get(i as u32).unwrap();
        assert_eq!(event.amount, *amount);
        assert_eq!(event.quote_id, String::from_str(&env, quote));
        assert_eq!(event.user, user);
    }
}
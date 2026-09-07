#![no_std]
use soroban_sdk::{contract, contractimpl, Address, Env, symbol_short, Symbol};

const BALANCE: Symbol = symbol_short!("BALANCE");

#[contract]
pub struct CreditEscrow;

#[contractimpl]
impl CreditEscrow {
    pub fn deposit(env: Env, from: Address, amount: i128) {
        from.require_auth();
        let current_balance: i128 = env.storage().instance().get(&BALANCE).unwrap_or(0);
        env.storage().instance().set(&BALANCE, &(current_balance + amount));
    }

    pub fn get_balance(env: Env) -> i128 {
        env.storage().instance().get(&BALANCE).unwrap_or(0)
    }
}

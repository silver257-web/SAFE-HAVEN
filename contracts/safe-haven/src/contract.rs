// ============================================================
//  SAFE-HAVEN — Soroban Smart Contract
//  Stellar Blockchain | Soroban SDK v22
// ============================================================

use soroban_sdk::{contract, contractimpl, token, Address, Env, Vec};

use crate::{
    constants::{
        MAX_BATCH_SIZE, MAX_DEPOSIT_AMOUNT, MAX_LOCK_DURATION_SECS, MIN_LOCK_DURATION_SECS,
        MIN_LOCK_LEDGERS,
    },
    errors::VaultError,
    events, storage,
    types::{VaultEntry, LedgerVaultEntry, InsurancePool, Page, STORAGE_VERSION},
};

#[contract]
pub struct SafeHaven;

#[contractimpl]
impl SafeHaven {
    // ----------------------------------------------------------------
    //  Initialization
    // ----------------------------------------------------------------

    pub fn initialize(
        env: Env,
        admin: Address,
        fee_recipient: Address,
        max_deposit: Option<i128>,
        max_lock_secs: Option<u64>,
    ) -> Result<(), VaultError> {
        admin.require_auth();

        // Use is_initialized as the sole re-initialization guard (closes #46).
        // Previously the contract checked admin presence, which became inconsistent
        // after renounce_admin(): the Initialized flag stayed true but there was no
        // admin, so a re-initialization call might pass the admin-presence check.
        // Using the dedicated Initialized flag is unambiguous in all states.
        if storage::is_initialized(&env) {
            return Err(VaultError::AlreadyInitialized);
        }

        storage::set_admin(&env, &admin);
        storage::set_initialized(&env);
        storage::set_fee_recipient(&env, &fee_recipient);

        if let Some(v) = max_deposit {
            if v <= 0 {
                return Err(VaultError::InvalidAmount);
            }
            storage::set_max_deposit(&env, v);
        }

        if let Some(v) = max_lock_secs {
            if v == 0 {
                return Err(VaultError::LockDurationTooLong);
            }
            storage::set_max_lock_secs(&env, v);
        }

        let effective_max_deposit = storage::get_max_deposit(&env).unwrap_or(MAX_DEPOSIT_AMOUNT);
        let effective_max_lock = storage::get_max_lock_secs(&env).unwrap_or(MAX_LOCK_DURATION_SECS);
        events::contract_initialized(&env, &admin, &fee_recipient, effective_max_deposit, effective_max_lock);

        Ok(())
    }

    // ----------------------------------------------------------------
    //  Core: Deposit
    // ----------------------------------------------------------------

    pub fn deposit(
        env: Env,
        depositor: Address,
        token: Address,
        amount: i128,
        unlock_time: u64,
        penalty_bps: u32,
    ) -> Result<u32, VaultError> {
        depositor.require_auth();

        if storage::is_paused(&env) {
            return Err(VaultError::ContractPaused);
        }

        if amount <= 0 {
            return Err(VaultError::InvalidAmount);
        }

        let max_deposit = storage::get_max_deposit(&env).unwrap_or(MAX_DEPOSIT_AMOUNT);
        if amount > max_deposit {
            return Err(VaultError::AmountTooLarge);
        }

        if penalty_bps > 10_000 {
            return Err(VaultError::InvalidPenaltyBps);
        }

        if penalty_bps > 0 && storage::get_fee_recipient(&env).is_none() {
            return Err(VaultError::MissingFeeRecipient);
        }

        let now = env.ledger().timestamp();
        if unlock_time <= now {
            return Err(VaultError::UnlockTimeNotInFuture);
        }

        let max_lock = storage::get_max_lock_secs(&env).unwrap_or(MAX_LOCK_DURATION_SECS);
        let lock_duration: u64 = unlock_time.saturating_sub(now);
        if lock_duration > max_lock {
            return Err(VaultError::LockDurationTooLong);
        }
        if lock_duration < MIN_LOCK_DURATION_SECS {
            return Err(VaultError::LockDurationTooShort);
        }

        let deposit_id = storage::next_deposit_id(&env, &depositor);

        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&depositor, &env.current_contract_address(), &amount);

        let entry = VaultEntry {
            token: token.clone(),
            amount,
            unlock_time,
            depositor: depositor.clone(),
            penalty_bps,
        };

        storage::set_deposit(&env, &depositor, deposit_id, &entry);
        storage::add_depositor(&env, &depositor);
        events::deposit(&env, &depositor, &token, amount, unlock_time, deposit_id);

        Ok(deposit_id)
    }

    pub fn deposit_for(
        env: Env,
        payer: Address,
        depositor: Address,
        token: Address,
        amount: i128,
        unlock_time: u64,
        penalty_bps: u32,
    ) -> Result<u32, VaultError> {
        payer.require_auth();

        if storage::is_paused(&env) {
            return Err(VaultError::ContractPaused);
        }

        if amount <= 0 {
            return Err(VaultError::InvalidAmount);
        }

        let max_deposit = storage::get_max_deposit(&env).unwrap_or(MAX_DEPOSIT_AMOUNT);
        if amount > max_deposit {
            return Err(VaultError::AmountTooLarge);
        }

        if penalty_bps > 10_000 {
            return Err(VaultError::InvalidPenaltyBps);
        }

        if penalty_bps > 0 && storage::get_fee_recipient(&env).is_none() {
            return Err(VaultError::MissingFeeRecipient);
        }

        let now = env.ledger().timestamp();
        if unlock_time <= now {
            return Err(VaultError::UnlockTimeNotInFuture);
        }

        let max_lock = storage::get_max_lock_secs(&env).unwrap_or(MAX_LOCK_DURATION_SECS);
        let lock_duration: u64 = unlock_time.saturating_sub(now);
        if lock_duration > max_lock {
            return Err(VaultError::LockDurationTooLong);
        }
        if lock_duration < MIN_LOCK_DURATION_SECS {
            return Err(VaultError::LockDurationTooShort);
        }

        let deposit_id = storage::next_deposit_id(&env, &depositor);

        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&payer, &env.current_contract_address(), &amount);

        let entry = VaultEntry {
            token: token.clone(),
            amount,
            unlock_time,
            depositor: depositor.clone(),
            penalty_bps,
        };

        storage::set_deposit(&env, &depositor, deposit_id, &entry);
        storage::add_depositor(&env, &depositor);
        events::deposit(&env, &depositor, &token, amount, unlock_time, deposit_id);

        Ok(deposit_id)
    }

    // ----------------------------------------------------------------
    //  Core: Deposit by Ledger Sequence (https://github.com/kenedybok3/SAFE-HAVEN/issues/88)
    // ----------------------------------------------------------------

    pub fn deposit_by_ledger(
        env: Env,
        depositor: Address,
        token: Address,
        amount: i128,
        unlock_ledger: u32,
        penalty_bps: u32,
    ) -> Result<u32, VaultError> {
        depositor.require_auth();

        if storage::is_paused(&env) {
            return Err(VaultError::ContractPaused);
        }

        if amount <= 0 {
            return Err(VaultError::InvalidAmount);
        }

        let max_deposit = storage::get_max_deposit(&env).unwrap_or(MAX_DEPOSIT_AMOUNT);
        if amount > max_deposit {
            return Err(VaultError::AmountTooLarge);
        }

        if penalty_bps > 10_000 {
            return Err(VaultError::InvalidPenaltyBps);
        }

        if penalty_bps > 0 && storage::get_fee_recipient(&env).is_none() {
            return Err(VaultError::MissingFeeRecipient);
        }

        let current_ledger = env.ledger().sequence();
        if unlock_ledger <= current_ledger {
            return Err(VaultError::UnlockTimeNotInFuture);
        }

        let ledger_gap = unlock_ledger.saturating_sub(current_ledger);
        if ledger_gap < MIN_LOCK_LEDGERS {
            return Err(VaultError::LockDurationTooShort);
        }

        let deposit_id = storage::next_deposit_id(&env, &depositor);

        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&depositor, &env.current_contract_address(), &amount);

        let entry = LedgerVaultEntry {
            token: token.clone(),
            amount,
            unlock_ledger,
            depositor: depositor.clone(),
            penalty_bps,
        };

        storage::set_deposit_by_ledger(&env, &depositor, deposit_id, &entry);
        storage::add_depositor(&env, &depositor);
        events::deposit_by_ledger(&env, &depositor, &token, amount, unlock_ledger, deposit_id);

        Ok(deposit_id)
    }

    // ----------------------------------------------------------------
    //  Core: Cancel Deposit (early exit with penalty)
    // ----------------------------------------------------------------

    pub fn cancel_deposit(env: Env, depositor: Address, deposit_id: u32) -> Result<(), VaultError> {
        depositor.require_auth();

        // Try timestamp-based deposit first
        if let Some(entry) = storage::get_deposit(&env, &depositor, deposit_id) {
            let now = env.ledger().timestamp();
            if now >= entry.unlock_time {
                return Err(VaultError::VaultAlreadyUnlocked);
            }

            storage::remove_deposit(&env, &depositor, deposit_id);
            if storage::get_deposit_ids(&env, &depositor).len() == 0 {
                storage::remove_depositor(&env, &depositor);
            }

            let token_client = token::Client::new(&env, &entry.token);
            let contract = env.current_contract_address();

            let penalty: i128 = (entry.amount * entry.penalty_bps as i128) / 10_000;
            let refund = entry.amount - penalty;

            if penalty > 0 {
                let fee_recipient =
                    storage::get_fee_recipient(&env).ok_or(VaultError::MissingFeeRecipient)?;
                token_client.transfer(&contract, &fee_recipient, &penalty);
            }
            if refund > 0 {
                token_client.transfer(&contract, &depositor, &refund);
            }

            events::deposit_cancelled(&env, &depositor, &entry.token, entry.amount, penalty, deposit_id);
            return Ok(());
        }

        // Try ledger-based deposit
        if let Some(entry) = storage::get_deposit_by_ledger_readonly(&env, &depositor, deposit_id) {
            let current_ledger = env.ledger().sequence();
            if current_ledger >= entry.unlock_ledger {
                return Err(VaultError::VaultAlreadyUnlocked);
            }

            storage::remove_deposit_by_ledger(&env, &depositor, deposit_id);
            if storage::get_deposit_ids(&env, &depositor).len() == 0 {
                storage::remove_depositor(&env, &depositor);
            }

            let token_client = token::Client::new(&env, &entry.token);
            let contract = env.current_contract_address();

            let penalty: i128 = (entry.amount * entry.penalty_bps as i128) / 10_000;
            let refund = entry.amount - penalty;

            if penalty > 0 {
                let fee_recipient =
                    storage::get_fee_recipient(&env).ok_or(VaultError::MissingFeeRecipient)?;
                token_client.transfer(&contract, &fee_recipient, &penalty);
            }
            if refund > 0 {
                token_client.transfer(&contract, &depositor, &refund);
            }

            events::deposit_cancelled(&env, &depositor, &entry.token, entry.amount, penalty, deposit_id);
            return Ok(());
        }

        Err(VaultError::NoDepositFound)
    }

    // ----------------------------------------------------------------
    //  Core: Withdraw
    // ----------------------------------------------------------------

    pub fn withdraw(env: Env, depositor: Address, deposit_id: u32) -> Result<(), VaultError> {
        depositor.require_auth();

        // Try timestamp-based deposit first
        if let Some(entry) = storage::get_deposit_readonly(&env, &depositor, deposit_id) {
            let now = env.ledger().timestamp();
            if now < entry.unlock_time {
                return Err(VaultError::FundsStillLocked);
            }

            storage::remove_deposit(&env, &depositor, deposit_id);
            if storage::get_deposit_ids(&env, &depositor).len() == 0 {
                storage::remove_depositor(&env, &depositor);
            }

            let token_client = token::Client::new(&env, &entry.token);
            token_client.transfer(&env.current_contract_address(), &depositor, &entry.amount);

            events::withdraw(&env, &depositor, &entry.token, entry.amount, deposit_id);
            return Ok(());
        }

        // Try ledger-based deposit
        if let Some(entry) = storage::get_deposit_by_ledger_readonly(&env, &depositor, deposit_id) {
            let current_ledger = env.ledger().sequence();
            if current_ledger < entry.unlock_ledger {
                return Err(VaultError::FundsStillLocked);
            }

            storage::remove_deposit_by_ledger(&env, &depositor, deposit_id);
            if storage::get_deposit_ids(&env, &depositor).len() == 0 {
                storage::remove_depositor(&env, &depositor);
            }

            let token_client = token::Client::new(&env, &entry.token);
            token_client.transfer(&env.current_contract_address(), &depositor, &entry.amount);

            events::withdraw(&env, &depositor, &entry.token, entry.amount, deposit_id);
            return Ok(());
        }

        Err(VaultError::NoDepositFound)
    }

    pub fn withdraw_to(
        env: Env,
        depositor: Address,
        deposit_id: u32,
        recipient: Address,
    ) -> Result<(), VaultError> {
        depositor.require_auth();

        // Try timestamp-based deposit first
        if let Some(entry) = storage::get_deposit_readonly(&env, &depositor, deposit_id) {
            let now = env.ledger().timestamp();
            if now < entry.unlock_time {
                return Err(VaultError::FundsStillLocked);
            }

            storage::remove_deposit(&env, &depositor, deposit_id);
            if storage::get_deposit_ids(&env, &depositor).len() == 0 {
                storage::remove_depositor(&env, &depositor);
            }

            let token_client = token::Client::new(&env, &entry.token);
            token_client.transfer(&env.current_contract_address(), &recipient, &entry.amount);

            events::withdraw_to(&env, &depositor, &recipient, &entry.token, entry.amount);
            return Ok(());
        }

        // Try ledger-based deposit
        if let Some(entry) = storage::get_deposit_by_ledger_readonly(&env, &depositor, deposit_id) {
            let current_ledger = env.ledger().sequence();
            if current_ledger < entry.unlock_ledger {
                return Err(VaultError::FundsStillLocked);
            }

            storage::remove_deposit_by_ledger(&env, &depositor, deposit_id);
            if storage::get_deposit_ids(&env, &depositor).len() == 0 {
                storage::remove_depositor(&env, &depositor);
            }

            let token_client = token::Client::new(&env, &entry.token);
            token_client.transfer(&env.current_contract_address(), &recipient, &entry.amount);

            events::withdraw_to(&env, &depositor, &recipient, &entry.token, entry.amount);
            return Ok(());
        }

        Err(VaultError::NoDepositFound)
    }

    // ----------------------------------------------------------------
    //  Admin: Emergency Withdrawal
    // ----------------------------------------------------------------

    pub fn emergency_withdraw(
        env: Env,
        admin: Address,
        depositor: Address,
        deposit_id: u32,
    ) -> Result<(), VaultError> {
        admin.require_auth();
        storage::require_admin(&env, &admin)?;

        // Try timestamp-based deposit first
        if let Some(entry) = storage::get_deposit_readonly(&env, &depositor, deposit_id) {
            storage::remove_deposit(&env, &depositor, deposit_id);
            if storage::get_deposit_ids(&env, &depositor).len() == 0 {
                storage::remove_depositor(&env, &depositor);
            }

            let token_client = token::Client::new(&env, &entry.token);
            token_client.transfer(&env.current_contract_address(), &depositor, &entry.amount);

            events::emergency_withdraw(&env, &admin, &depositor, &entry.token, entry.amount, deposit_id);
            return Ok(());
        }

        // Try ledger-based deposit
        if let Some(entry) = storage::get_deposit_by_ledger_readonly(&env, &depositor, deposit_id) {
            storage::remove_deposit_by_ledger(&env, &depositor, deposit_id);
            if storage::get_deposit_ids(&env, &depositor).len() == 0 {
                storage::remove_depositor(&env, &depositor);
            }

            let token_client = token::Client::new(&env, &entry.token);
            token_client.transfer(&env.current_contract_address(), &depositor, &entry.amount);

            events::emergency_withdraw(&env, &admin, &depositor, &entry.token, entry.amount, deposit_id);
            return Ok(());
        }

        Err(VaultError::NoDepositFound)
    }

    // ----------------------------------------------------------------
    //  Admin: Pause / Unpause
    // ----------------------------------------------------------------

    pub fn pause(env: Env, admin: Address) -> Result<(), VaultError> {
        admin.require_auth();
        let stored_admin = storage::get_admin(&env).ok_or(VaultError::Unauthorized)?;
        if admin != stored_admin {
            return Err(VaultError::Unauthorized);
        }
        storage::set_paused(&env, true);
        events::paused(&env, &admin);
        Ok(())
    }

    pub fn unpause(env: Env, admin: Address) -> Result<(), VaultError> {
        admin.require_auth();
        let stored_admin = storage::get_admin(&env).ok_or(VaultError::Unauthorized)?;
        if admin != stored_admin {
            return Err(VaultError::Unauthorized);
        }
        storage::set_paused(&env, false);
        events::unpaused(&env, &admin);
        Ok(())
    }

    /// Configure the insurance pool. The reserve is the contract's balance of
    /// `token`, so funding remains a normal token transfer to this contract.
    pub fn configure_insurance(
        env: Env,
        admin: Address,
        token: Address,
        coverage_bps: u32,
        max_coverage: i128,
    ) -> Result<(), VaultError> {
        admin.require_auth();
        storage::require_admin(&env, &admin)?;
        if coverage_bps > 10_000 || max_coverage <= 0 {
            return Err(VaultError::InvalidInsuranceConfig);
        }

        let token_client = token::Client::new(&env, &token);
        let reserve = token_client.balance(&env.current_contract_address());
        storage::set_insurance_pool(&env, &InsurancePool {
            enabled: true,
            token,
            coverage_bps,
            max_coverage,
            reserve,
        });
        Ok(())
    }

    pub fn disable_insurance(env: Env, admin: Address) -> Result<(), VaultError> {
        admin.require_auth();
        storage::require_admin(&env, &admin)?;
        if let Some(mut pool) = storage::get_insurance_pool(&env) {
            pool.enabled = false;
            storage::set_insurance_pool(&env, &pool);
        }
        Ok(())
    }

    /// Register a wallet that may recover this depositor's active vaults.
    pub fn register_recovery_contact(
        env: Env,
        depositor: Address,
        recovery_contact: Address,
    ) -> Result<(), VaultError> {
        depositor.require_auth();
        if depositor == recovery_contact {
            return Err(VaultError::InvalidRecoveryContact);
        }
        storage::set_recovery_owner(&env, &recovery_contact, &depositor);
        Ok(())
    }

    /// Move all active vaults from the registered owner to a replacement wallet.
    /// Both the recovery wallet and replacement wallet must authorize the call.
    pub fn recover_account(
        env: Env,
        recovery_contact: Address,
        new_wallet: Address,
    ) -> Result<u32, VaultError> {
        recovery_contact.require_auth();
        let old_wallet = storage::get_recovery_owner(&env, &recovery_contact)
            .ok_or(VaultError::InvalidRecoveryContact)?;
        if old_wallet == new_wallet {
            return Err(VaultError::InvalidRecoveryContact);
        }

        let ids = storage::get_deposit_ids(&env, &old_wallet);
        let mut recovered: u32 = 0;
        for deposit_id in ids.iter() {
            if let Some(mut entry) = storage::get_deposit_readonly(&env, &old_wallet, deposit_id) {
                storage::remove_deposit(&env, &old_wallet, deposit_id);
                entry.depositor = new_wallet.clone();
                let new_id = storage::next_deposit_id(&env, &new_wallet);
                storage::set_deposit(&env, &new_wallet, new_id, &entry);
                recovered = recovered.saturating_add(1);
            } else if let Some(mut entry) = storage::get_deposit_by_ledger_readonly(&env, &old_wallet, deposit_id) {
                storage::remove_deposit_by_ledger(&env, &old_wallet, deposit_id);
                entry.depositor = new_wallet.clone();
                let new_id = storage::next_deposit_id(&env, &new_wallet);
                storage::set_deposit_by_ledger(&env, &new_wallet, new_id, &entry);
                recovered = recovered.saturating_add(1);
            }
        }
        if recovered > 0 {
            storage::add_depositor(&env, &new_wallet);
            if storage::get_deposit_ids(&env, &old_wallet).len() == 0 {
                storage::remove_depositor(&env, &old_wallet);
            }
        }
        Ok(recovered)
    }

    pub fn is_paused(env: Env) -> bool {
        storage::is_paused(&env)
    }

    // ----------------------------------------------------------------
    //  Admin: Two-Step Admin Transfer
    // ----------------------------------------------------------------

    pub fn transfer_admin(env: Env, admin: Address, new_admin: Address) -> Result<(), VaultError> {
        admin.require_auth();
        let stored_admin = storage::get_admin(&env).ok_or(VaultError::Unauthorized)?;
        if admin != stored_admin {
            return Err(VaultError::Unauthorized);
        }

        if new_admin == stored_admin {
            return Err(VaultError::InvalidAdmin);
        }

        storage::set_pending_admin(&env, &new_admin);
        events::admin_transfer_initiated(&env, &admin, &new_admin);
        Ok(())
    }

    pub fn accept_admin(env: Env, new_admin: Address) -> Result<(), VaultError> {
        new_admin.require_auth();

        let pending_admin = storage::get_pending_admin(&env).ok_or(VaultError::Unauthorized)?;
        if new_admin != pending_admin {
            return Err(VaultError::Unauthorized);
        }

        storage::set_admin(&env, &new_admin);
        storage::remove_pending_admin(&env);
        events::admin_transfer_accepted(&env, &new_admin);
        Ok(())
    }

    pub fn cancel_transfer_admin(env: Env, admin: Address) -> Result<(), VaultError> {
        admin.require_auth();

        let stored_admin = storage::get_admin(&env).ok_or(VaultError::Unauthorized)?;
        if admin != stored_admin {
            return Err(VaultError::Unauthorized);
        }

        // Emit an event when a pending admin is cancelled so off-chain indexers
        // and UIs observing admin state transitions won't show a stale pending admin.
        if let Some(pending) = storage::get_pending_admin(&env) {
            storage::remove_pending_admin(&env);
            events::admin_transfer_cancelled(&env, &admin, &pending);
        }
        Ok(())
    }

    pub fn renounce_admin(env: Env, admin: Address) -> Result<(), VaultError> {
        admin.require_auth();

        let stored_admin = storage::get_admin(&env).ok_or(VaultError::Unauthorized)?;
        if admin != stored_admin {
            return Err(VaultError::Unauthorized);
        }

        storage::remove_admin(&env);
        storage::remove_pending_admin(&env);
        events::admin_renounced(&env, &admin);
        Ok(())
    }

    // ----------------------------------------------------------------
    //  Read-only Queries
    // ----------------------------------------------------------------

    /// No auth required — this is a public read-only query (closes https://github.com/kenedybok3/SAFE-HAVEN/issues/81)
    pub fn get_vault(env: Env, depositor: Address, deposit_id: u32) -> Option<VaultEntry> {
        storage::get_deposit_readonly(&env, &depositor, deposit_id)
    }

    /// Returns the `LedgerVaultEntry` for a ledger-sequence-based deposit, or `None` if not found.
    /// No auth required — public read-only query (closes https://github.com/kenedybok3/SAFE-HAVEN/issues/44).
    pub fn get_ledger_vault(env: Env, depositor: Address, deposit_id: u32) -> Option<LedgerVaultEntry> {
        storage::get_deposit_by_ledger_readonly(&env, &depositor, deposit_id)
    }

    /// Returns whether a deposit is timestamp-based (`DepositType::TimeBased`) or
    /// ledger-sequence-based (`DepositType::LedgerBased`), or `None` if no deposit
    /// exists at the given `(depositor, deposit_id)` pair.
    ///
    /// This eliminates the need for callers to speculatively call both `get_vault`
    /// and `get_ledger_vault` just to determine the deposit type, saving a full RPC
    /// round-trip on every lookup (closes #47).
    ///
    /// No auth required — public read-only query.
    pub fn get_deposit_type(env: Env, depositor: Address, deposit_id: u32) -> Option<DepositType> {
        if storage::get_deposit_readonly(&env, &depositor, deposit_id).is_some() {
            return Some(DepositType::TimeBased);
        }
        if storage::get_deposit_by_ledger_readonly(&env, &depositor, deposit_id).is_some() {
            return Some(DepositType::LedgerBased);
        }
        None
    }

    pub fn get_vault_batch(env: Env, depositors: Vec<Address>, deposit_id: u32) -> Vec<Option<VaultEntry>> {
        let limit = if depositors.len() > MAX_BATCH_SIZE { MAX_BATCH_SIZE } else { depositors.len() as u32 };
        let mut results = Vec::new(&env);
        for i in 0..limit {
            if let Some((depositor, deposit_id)) = pairs.get(i) {
                let entry = storage::get_deposit_readonly(&env, &depositor, deposit_id);
                results.push_back(entry);
            }
        }
        results
    }

    /// Fetch multiple deposits for a single depositor in one RPC call.
    /// Limit: up to 25 deposit IDs per call.
    /// Returns Vec of (deposit_id, Option<VaultEntry>) pairs.
    pub fn get_deposit_batch(
        env: Env,
        depositor: Address,
        deposit_ids: Vec<u32>,
    ) -> Vec<(u32, Option<VaultEntry>)> {
        let limit = if deposit_ids.len() > MAX_BATCH_SIZE {
            MAX_BATCH_SIZE
        } else {
            deposit_ids.len()
        };
        let mut results = Vec::new(&env);
        for i in 0..limit {
            if let Some(id) = deposit_ids.get(i) {
                let entry = storage::get_deposit_readonly(&env, &depositor, id);
                results.push_back((id, entry));
            }
        }
        results
    }

    pub fn get_deposit_ids(env: Env, depositor: Address) -> Vec<u32> {
        storage::get_deposit_ids(&env, &depositor)
    }

    /// Returns the current ledger timestamp.
    /// Read-only — does not bump storage TTL.
    pub fn get_time(env: Env) -> u64 {
        env.ledger().timestamp()
    }

    /// No auth required — this is a public read-only query (closes https://github.com/kenedybok3/SAFE-HAVEN/issues/81)
    ///
    /// For timestamp-based deposits: returns exact seconds remaining.
    /// For ledger-based deposits: returns an estimate in seconds using
    /// `LEDGER_SECONDS` (fixes https://github.com/kenedybok3/SAFE-HAVEN/issues/21). Returns 0 when unlocked or not found.
    pub fn time_remaining(env: Env, depositor: Address, deposit_id: u32) -> u64 {
        // Timestamp-based path
        if let Some(entry) = storage::get_deposit_readonly(&env, &depositor, deposit_id) {
            let now = env.ledger().timestamp();
            return entry.unlock_time.saturating_sub(now);
        }

        // Ledger-based path: convert remaining ledgers → estimated seconds (fixes https://github.com/kenedybok3/SAFE-HAVEN/issues/21)
        if let Some(entry) = storage::get_deposit_by_ledger_readonly(&env, &depositor, deposit_id) {
            let current = env.ledger().sequence();
            if current >= entry.unlock_ledger {
                return 0;
            }
            let remaining_ledgers = (entry.unlock_ledger - current) as u64;
            return remaining_ledgers.saturating_mul(storage::LEDGER_SECONDS);
        }

        0
    }

    pub fn get_admin(env: Env) -> Option<Address> {
        storage::get_admin(&env)
    }

    pub fn get_pending_admin(env: Env) -> Option<Address> {
        storage::get_pending_admin(&env)
    }

    pub fn get_constants(env: Env) -> (i128, u64) {
        let max_deposit = storage::get_max_deposit(&env).unwrap_or(MAX_DEPOSIT_AMOUNT);
        let max_lock = storage::get_max_lock_secs(&env).unwrap_or(MAX_LOCK_DURATION_SECS);
        (max_deposit, max_lock)
    }

    pub fn get_fee_recipient(env: Env) -> Option<Address> {
        storage::get_fee_recipient(&env)
    }

    /// Returns the configured insurance terms and current reserve balance.
    /// The reserve is refreshed from the configured token balance on every query.
    pub fn get_insurance_pool(env: Env) -> Option<InsurancePool> {
        let mut pool = storage::get_insurance_pool(&env)?;
        let token_client = token::Client::new(&env, &pool.token);
        pool.reserve = token_client.balance(&env.current_contract_address());
        Some(pool)
    }

    pub fn get_depositor_count(env: Env) -> u32 {
        storage::get_depositor_count(&env)
    }

    /// Returns a page of depositor addresses and the total count of all active depositors.
    /// This allows callers to implement pagination without a separate RPC call.
    ///
    /// # Parameters
    /// - `offset`: Number of active depositors to skip (0-indexed)
    /// - `limit`: Maximum number of addresses to return in this page
    ///
    /// # Returns
    /// A `Page<Address>` containing:
    /// - `items`: The paginated list of addresses
    /// - `total_count`: Total number of active depositors across all pages
    pub fn get_depositors(env: Env, offset: u32, limit: u32) -> Page<Address> {
        let (items, total_count) = storage::get_depositors_page(&env, offset, limit);
        Page { items, total_count }
    }

    pub fn is_initialized(env: Env) -> bool {
        storage::is_initialized(&env)
    }

    /// Returns the contract version from Cargo.toml at compile time.
    /// Allows clients and monitoring tools to confirm which version is deployed
    /// without inspecting bytecode directly.
    pub fn version(_env: Env) -> soroban_sdk::String {
        soroban_sdk::String::from_slice(&_env, env!("CARGO_PKG_VERSION"))
    }

    // ----------------------------------------------------------------
    //  Read-only: Paginated flat deposits view (Task 1)
    // ----------------------------------------------------------------

    /// Returns a paginated flat list of all active timestamp-based deposits across
    /// every depositor.  Each element is `(depositor, deposit_id, VaultEntry)`.
    ///
    /// `offset` and `limit` are applied to the *deposit* stream, not the depositor
    /// list, so callers get a predictable page size regardless of how many deposits
    /// each depositor holds.  Ledger-based deposits are not included here; use
    /// `get_depositors` + `get_deposit_ids` to enumerate those.
    ///
    /// Gas note: this function reads every depositor's ID list up to `offset + limit`
    /// deposits.  Keep `limit` reasonable (≤ 50) in production to stay within the
    /// Soroban instruction budget.
    pub fn get_deposits_page(
        env: Env,
        offset: u32,
        limit: u32,
    ) -> Vec<(Address, u32, VaultEntry)> {
        let mut results: Vec<(Address, u32, VaultEntry)> = Vec::new(&env);
        let mut global_index: u32 = 0;
        let end_at = offset.saturating_add(limit);

        // Walk all depositors in insertion order, skipping stale (flag-removed) ones.
        let depositor_list = storage::get_all_depositors_raw(&env);
        for depositor in depositor_list.iter() {
            if global_index >= end_at {
                break;
            }
            // Skip depositors whose flag has been cleared (O(1) remove).
            if !storage::depositor_is_active(&env, &depositor) {
                continue;
            }
            let ids = storage::get_deposit_ids(&env, &depositor);
            for id in ids.iter() {
                if global_index >= end_at {
                    break;
                }
                if let Some(entry) = storage::get_deposit_readonly(&env, &depositor, id) {
                    if global_index >= offset {
                        results.push_back((depositor.clone(), id, entry));
                    }
                    global_index = global_index.saturating_add(1);
                }
            }
        }
        results
    }

    // ----------------------------------------------------------------
    //  Admin: Storage migration (Task 4)
    // ----------------------------------------------------------------

    /// Returns the schema version currently stored on-chain.
    /// Returns `None` for contracts deployed before versioning was introduced
    /// (treat as version 0 / pre-migration).
    pub fn get_storage_version(env: Env) -> Option<u32> {
        storage::get_storage_version(&env)
    }

    /// Admin-only migration hook.
    ///
    /// Call this after upgrading the contract WASM to a version that changed the
    /// layout of a `#[contracttype]` struct.  The function:
    ///
    /// 1. Verifies admin auth.
    /// 2. Reads the current on-chain version (`None` → 0).
    /// 3. Applies each migration step in order (currently a no-op placeholder
    ///    that demonstrates the pattern — replace with real field backfills when
    ///    `VaultEntry` gains new fields).
    /// 4. Writes `STORAGE_VERSION` so subsequent calls are idempotent.
    ///
    /// Returning `Ok(false)` means the schema was already up-to-date; no work done.
    /// Returning `Ok(true)` means migration was applied.
    pub fn migrate(env: Env, admin: Address) -> Result<bool, VaultError> {
        admin.require_auth();
        storage::require_admin(&env, &admin)?;

        let current_version = storage::get_storage_version(&env).unwrap_or(0);

        if current_version >= STORAGE_VERSION {
            // Already at the current schema version — nothing to do.
            return Ok(false);
        }

        // ── Migration v0 → v1 ───────────────────────────────────────────────
        // Version 1 introduces the StorageVersion key itself.  No struct fields
        // changed in this version, so the migration is a no-op data-wise.
        // When a future version (e.g. v2) adds a field to VaultEntry, add a
        // loop here that reads every deposit in the old format and rewrites it
        // with the new default field value.
        // ────────────────────────────────────────────────────────────────────

        storage::set_storage_version(&env, STORAGE_VERSION);
        Ok(true)
    }
}

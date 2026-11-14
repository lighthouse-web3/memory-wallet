//! Memory Wallet registry.
//!
//! The contract never sees a memory or a key. For each account it keeps:
//!  - `check`: 16 bytes derived from the account's vault key, so the vault can tell at unlock
//!    that the wallet produced the same key as last time (and refuse to write otherwise);
//!  - `roots`: for each scope ("travel", "health", ...) the CID of the latest encrypted snapshot
//!    on Lighthouse;
//!  - `grants`: which app origins may use which scopes, until when.
//!
//! Only the account itself can change its entry (`predecessor_account_id`). Grants are public on
//! purpose: anyone can audit which apps an account has let in, and every change emits a
//! NEP-297 event.

use near_sdk::borsh::BorshSerialize;
use near_sdk::serde_json::{Value, json};
use near_sdk::store::LookupMap;
use near_sdk::{AccountId, BorshStorageKey, env, near, require};

const MAX_SCOPES: usize = 16;
const MAX_GRANTS: usize = 32;
const MAX_TTL_MINUTES: u32 = 60 * 24 * 30;

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct ScopeRoot {
    pub scope: String,
    pub cid: String,
    pub count: u32,
    pub updated_at_ms: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Grant {
    /// The app's web origin, e.g. `https://trip.example` — what the vault checks `postMessage` against.
    pub app: String,
    pub scopes: Vec<String>,
    /// Whether the app may add memories to these scopes (the vault still encrypts them).
    pub write: bool,
    /// Whether the app may receive the text of memories in these scopes. Off by default: then the
    /// app only ever gets answers computed inside an attested TEE. On is for apps the user chooses
    /// to trust with the text (e.g. a chat app outside a TEE) — and it is public here, on-chain.
    pub reveal: bool,
    pub created_at_ms: u64,
    pub expires_at_ms: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone, Default)]
pub struct Vault {
    pub check: Option<String>,
    pub roots: Vec<ScopeRoot>,
    pub grants: Vec<Grant>,
}

#[near(serializers = [json])]
#[derive(Debug)]
pub struct VaultView {
    pub owner: AccountId,
    pub check: Option<String>,
    pub roots: Vec<ScopeRoot>,
    /// Active grants only.
    pub grants: Vec<Grant>,
}

#[derive(BorshSerialize, BorshStorageKey)]
#[borsh(crate = "near_sdk::borsh")]
enum StorageKey {
    Vaults,
}

#[near(contract_state)]
pub struct Registry {
    vaults: LookupMap<AccountId, Vault>,
}

impl Default for Registry {
    fn default() -> Self {
        Self { vaults: LookupMap::new(StorageKey::Vaults) }
    }
}

fn emit(event: &str, data: Value) {
    let body = json!({ "standard": "memory-wallet", "version": "1.0.0", "event": event, "data": [data] });
    env::log_str(&format!("EVENT_JSON:{body}"));
}

fn valid_scope(scope: &str) -> bool {
    !scope.is_empty()
        && scope.len() <= 32
        && scope.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
}

fn valid_cid(cid: &str) -> bool {
    (8..=100).contains(&cid.len()) && cid.bytes().all(|b| b.is_ascii_alphanumeric())
}

fn valid_app(app: &str) -> bool {
    let rest = match app.strip_prefix("https://").or_else(|| app.strip_prefix("http://")) {
        Some(rest) => rest,
        None => return false,
    };
    !rest.is_empty()
        && app.len() <= 120
        && rest.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-' || b == b':')
}

impl Registry {
    fn load(&self, owner: &AccountId) -> Vault {
        self.vaults.get(owner).cloned().unwrap_or_default()
    }
}

#[near]
impl Registry {
    /// Records the vault key check. Refuses a different one: that would mean the wallet produced
    /// another key, and writing with it would orphan every existing memory. `reset_vault` first.
    pub fn set_check(&mut self, check: String) {
        require!(check.len() == 32 && check.bytes().all(|b| b.is_ascii_hexdigit()), "check must be 32 hex characters");
        let owner = env::predecessor_account_id();
        let mut vault = self.load(&owner);
        if let Some(existing) = &vault.check {
            require!(existing == &check, "this vault already has a different key check; call reset_vault first");
        }
        vault.check = Some(check);
        self.vaults.insert(owner, vault);
    }

    /// Points `scope` at the latest encrypted snapshot.
    pub fn set_root(&mut self, scope: String, cid: String, count: u32) {
        require!(valid_scope(&scope), "scope must be 1-32 characters of a-z, 0-9, - or _");
        require!(valid_cid(&cid), "cid must be 8-100 alphanumeric characters");
        let owner = env::predecessor_account_id();
        let mut vault = self.load(&owner);
        let now = env::block_timestamp_ms();
        if let Some(i) = vault.roots.iter().position(|r| r.scope == scope) {
            let root = &mut vault.roots[i];
            root.cid = cid.clone();
            root.count = count;
            root.updated_at_ms = now;
        } else {
            require!(vault.roots.len() < MAX_SCOPES, "too many scopes");
            vault.roots.push(ScopeRoot { scope: scope.clone(), cid: cid.clone(), count, updated_at_ms: now });
        }
        self.vaults.insert(owner.clone(), vault);
        emit("set_root", json!({ "owner": owner, "scope": scope, "cid": cid, "count": count }));
    }

    /// Lets `app` (a web origin) use `scopes` for `ttl_minutes`. Replaces any earlier grant to it.
    pub fn grant(&mut self, app: String, scopes: Vec<String>, write: bool, ttl_minutes: u32, reveal: Option<bool>) {
        let reveal = reveal.unwrap_or(false);
        require!(valid_app(&app), "app must be a lowercase origin like https://app.example");
        require!(!scopes.is_empty() && scopes.len() <= MAX_SCOPES, "grant 1 to 16 scopes");
        for scope in &scopes {
            require!(valid_scope(scope), "scope must be 1-32 characters of a-z, 0-9, - or _");
        }
        require!((1..=MAX_TTL_MINUTES).contains(&ttl_minutes), "ttl_minutes must be 1 to 43200");

        let owner = env::predecessor_account_id();
        let mut vault = self.load(&owner);
        let now = env::block_timestamp_ms();
        vault.grants.retain(|g| g.app != app && g.expires_at_ms > now);
        require!(vault.grants.len() < MAX_GRANTS, "too many active grants");

        let mut scopes = scopes;
        scopes.sort();
        scopes.dedup();
        let expires_at_ms = now + u64::from(ttl_minutes) * 60_000;
        vault.grants.push(Grant { app: app.clone(), scopes: scopes.clone(), write, reveal, created_at_ms: now, expires_at_ms });
        self.vaults.insert(owner.clone(), vault);
        emit("grant", json!({ "owner": owner, "app": app, "scopes": scopes, "write": write, "reveal": reveal, "expires_at_ms": expires_at_ms }));
    }

    pub fn revoke(&mut self, app: String) {
        let owner = env::predecessor_account_id();
        let mut vault = self.load(&owner);
        let before = vault.grants.len();
        vault.grants.retain(|g| g.app != app);
        require!(vault.grants.len() < before, "no grant for this app");
        self.vaults.insert(owner.clone(), vault);
        emit("revoke", json!({ "owner": owner, "app": app }));
    }

    /// Forgets the caller's check, roots and grants. The encrypted blobs stay on Lighthouse.
    pub fn reset_vault(&mut self) {
        let owner = env::predecessor_account_id();
        self.vaults.remove(&owner);
        emit("reset_vault", json!({ "owner": owner }));
    }

    pub fn get_vault(&self, owner: AccountId) -> Option<VaultView> {
        let now = env::block_timestamp_ms();
        self.vaults.get(&owner).map(|v| VaultView {
            owner: owner.clone(),
            check: v.check.clone(),
            roots: v.roots.clone(),
            grants: v.grants.iter().filter(|g| g.expires_at_ms > now).cloned().collect(),
        })
    }

    /// The active grant from `owner` to `app`, if any. Expired grants read as none.
    pub fn get_grant(&self, owner: AccountId, app: String) -> Option<Grant> {
        let now = env::block_timestamp_ms();
        self.vaults
            .get(&owner)
            .and_then(|v| v.grants.iter().find(|g| g.app == app && g.expires_at_ms > now).cloned())
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use near_sdk::test_utils::{VMContextBuilder, accounts, get_logs};
    use near_sdk::testing_env;

    const CID: &str = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";
    const APP: &str = "http://localhost:5174";
    const CHECK: &str = "00112233445566778899aabbccddeeff";

    fn as_account(who: AccountId, at_ms: u64) {
        let mut b = VMContextBuilder::new();
        b.current_account_id(accounts(0))
            .signer_account_id(who.clone())
            .predecessor_account_id(who)
            .block_timestamp(at_ms * 1_000_000);
        testing_env!(b.build());
    }

    #[test]
    fn roots_are_set_and_updated() {
        let mut c = Registry::default();
        as_account(accounts(1), 1_000);
        c.set_root("travel".into(), CID.into(), 3);
        c.set_root("travel".into(), CID.into(), 4);
        c.set_root("food".into(), CID.into(), 1);
        let v = c.get_vault(accounts(1)).unwrap();
        assert_eq!(v.roots.len(), 2);
        assert_eq!(v.roots[0].count, 4);
        assert!(get_logs().iter().any(|l| l.starts_with("EVENT_JSON:") && l.contains("\"set_root\"")));
    }

    #[test]
    fn owners_are_isolated() {
        let mut c = Registry::default();
        as_account(accounts(1), 1_000);
        c.set_root("travel".into(), CID.into(), 1);
        assert!(c.get_vault(accounts(2)).is_none());
    }

    #[test]
    fn grants_expire() {
        let mut c = Registry::default();
        as_account(accounts(1), 1_000);
        c.grant(APP.into(), vec!["travel".into(), "food".into(), "travel".into()], false, 10, None);
        let g = c.get_grant(accounts(1), APP.into()).unwrap();
        assert_eq!(g.scopes, vec!["food".to_string(), "travel".to_string()]);
        assert_eq!(g.expires_at_ms, 1_000 + 10 * 60_000);

        as_account(accounts(1), 1_000 + 10 * 60_000);
        assert!(c.get_grant(accounts(1), APP.into()).is_none());
        assert!(c.get_vault(accounts(1)).unwrap().grants.is_empty());
    }

    #[test]
    fn regrant_replaces_and_revoke_removes() {
        let mut c = Registry::default();
        as_account(accounts(1), 1_000);
        c.grant(APP.into(), vec!["travel".into()], false, 10, None);
        c.grant(APP.into(), vec!["food".into()], true, 10, None);
        let v = c.get_vault(accounts(1)).unwrap();
        assert_eq!(v.grants.len(), 1);
        assert!(v.grants[0].write);
        assert!(!v.grants[0].reveal, "reveal is off unless asked for");
        c.revoke(APP.into());
        assert!(c.get_grant(accounts(1), APP.into()).is_none());
    }

    #[test]
    fn reveal_is_recorded_per_grant() {
        let mut c = Registry::default();
        as_account(accounts(1), 1_000);
        c.grant("https://chatgpt.com".into(), vec!["travel".into()], true, 60, Some(true));
        c.grant(APP.into(), vec!["travel".into()], false, 60, Some(false));
        assert!(c.get_grant(accounts(1), "https://chatgpt.com".into()).unwrap().reveal);
        assert!(!c.get_grant(accounts(1), APP.into()).unwrap().reveal);
    }

    #[test]
    #[should_panic(expected = "no grant for this app")]
    fn revoke_unknown_app_fails() {
        let mut c = Registry::default();
        as_account(accounts(1), 1_000);
        c.revoke(APP.into());
    }

    #[test]
    #[should_panic(expected = "scope must be")]
    fn rejects_bad_scope() {
        let mut c = Registry::default();
        as_account(accounts(1), 1_000);
        c.set_root("Travel Plans".into(), CID.into(), 1);
    }

    #[test]
    #[should_panic(expected = "app must be")]
    fn rejects_non_origin_app() {
        let mut c = Registry::default();
        as_account(accounts(1), 1_000);
        c.grant("https://app.example/path".into(), vec!["travel".into()], false, 10, None);
    }

    #[test]
    #[should_panic(expected = "different key check")]
    fn check_cannot_be_swapped() {
        let mut c = Registry::default();
        as_account(accounts(1), 1_000);
        c.set_check(CHECK.into());
        c.set_check(CHECK.into()); // same one is fine
        c.set_check("ffeeddccbbaa99887766554433221100".into());
    }

    #[test]
    fn reset_clears_everything() {
        let mut c = Registry::default();
        as_account(accounts(1), 1_000);
        c.set_check(CHECK.into());
        c.set_root("travel".into(), CID.into(), 1);
        c.reset_vault();
        assert!(c.get_vault(accounts(1)).is_none());
        c.set_check("ffeeddccbbaa99887766554433221100".into());
    }
}

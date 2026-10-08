//! Configurable `Origin` allowlist for browser WebSocket upgrades (plano 69 W4).
//!
//! Browsers attach an `Origin` header to every WS handshake; native clients
//! (app, pi-extension, Cockpit) send none. The policy therefore only gates
//! handshakes that *do* present an `Origin`:
//!
//! - **Unset / empty allowlist → permissive.** Every origin is accepted,
//!   which is the relay's historical behaviour and stays the default
//!   (backward compatibility is sacred).
//! - **Configured allowlist → only listed origins pass.** Anything else is
//!   refused with `403 Forbidden` before the upgrade. Handshakes *without*
//!   an `Origin` header are still accepted, so enabling the allowlist never
//!   breaks native clients.
//!
//! Entries are compared **exactly** (case-sensitive; scheme + host + port;
//! no wildcards, no paths) — e.g. `https://app.example.com` matches only
//! that exact origin string. Browsers lowercase scheme and host, so write
//! entries in lowercase.
//!
//! This is a browser-context restriction, **not** an authentication
//! mechanism: a non-browser client can simply omit the header. WS
//! authentication remains the Ed25519 hello/challenge handshake.

use std::env;

/// Env var that configures the allowlist: comma-separated origins, e.g.
/// `RELAY_ALLOWED_ORIGINS="https://app.example.com,https://cockpit.example.com"`.
/// Unset, empty or whitespace-only → disabled (all origins accepted).
pub const ALLOWED_ORIGINS_ENV: &str = "RELAY_ALLOWED_ORIGINS";

/// Origin allowlist shared by the WS upgrade route. Cheap to clone (a small
/// `Vec`), held in [`crate::AppState`] behind an `Arc`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OriginPolicy {
    entries: Vec<String>,
}

impl OriginPolicy {
    /// Reads the allowlist from [`ALLOWED_ORIGINS_ENV`]. Called once at
    /// startup (`main`) — never per connection.
    pub fn from_env() -> Self {
        Self::from_allowlist(&env::var(ALLOWED_ORIGINS_ENV).unwrap_or_default())
    }

    /// Builds a policy from the raw allowlist value (comma-separated
    /// origins). Whitespace around entries is trimmed and empty entries are
    /// dropped, so `""`, `"   "` and `" , , "` all yield a disabled policy.
    pub fn from_allowlist(raw: &str) -> Self {
        let entries = raw
            .split(',')
            .map(str::trim)
            .filter(|entry| !entry.is_empty())
            .map(String::from)
            .collect();
        Self { entries }
    }

    /// `true` when at least one origin is configured.
    pub fn is_enabled(&self) -> bool {
        !self.entries.is_empty()
    }

    /// Configured origins — for the startup log line, so ops can confirm
    /// `RELAY_ALLOWED_ORIGINS` took effect.
    pub fn entries(&self) -> &[String] {
        &self.entries
    }

    /// Decides whether a WS upgrade carrying `origin` (the request's `Origin`
    /// header, `None` when absent) may proceed:
    ///
    /// - allowlist disabled → always `true` (historical behaviour);
    /// - `origin == None` (native client) → `true` even when enabled;
    /// - otherwise → exact match against the configured entries.
    ///
    /// A malformed (non-UTF-8) `Origin` header is represented as `Some("")`,
    /// which no configured entry can equal (empty entries are dropped), so
    /// it is refused while the allowlist is active.
    pub fn allows(&self, origin: Option<&str>) -> bool {
        if !self.is_enabled() {
            return true;
        }
        match origin {
            None => true,
            Some(origin) => self.entries.iter().any(|entry| entry == origin),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_allowlist_is_permissive() {
        // Unset / empty / whitespace-only → every origin passes. This is the
        // documented default and preserves the pre-allowlist behaviour.
        for raw in ["", "   ", " , , "] {
            let policy = OriginPolicy::from_allowlist(raw);
            assert!(!policy.is_enabled(), "raw {raw:?} must stay disabled");
            assert!(policy.allows(Some("https://anything.example.com")));
            assert!(policy.allows(Some("http://127.0.0.1:3000")));
            assert!(policy.allows(None));
        }
    }

    #[test]
    fn accepts_listed_origin() {
        let policy =
            OriginPolicy::from_allowlist("https://app.example.com, https://cockpit.example.com");
        assert!(policy.is_enabled());
        assert!(policy.allows(Some("https://app.example.com")));
        assert!(policy.allows(Some("https://cockpit.example.com")));
    }

    #[test]
    fn rejects_unlisted_origin() {
        let policy = OriginPolicy::from_allowlist("https://app.example.com");
        assert!(!policy.allows(Some("https://evil.example.com")));
        // Prefix/suffix tricks must not sneak past an exact match.
        assert!(!policy.allows(Some("https://app.example.com.evil.com")));
        assert!(!policy.allows(Some("https://evil.com/app.example.com")));
        // Scheme matters.
        assert!(!policy.allows(Some("http://app.example.com")));
        // `null` origin (sandboxed iframe / file:// page).
        assert!(!policy.allows(Some("null")));
        // Malformed (non-UTF-8) header value, mapped to Some("").
        assert!(!policy.allows(Some("")));
    }

    #[test]
    fn missing_origin_header_is_always_allowed() {
        // Native clients (app, pi-extension, Cockpit) send no Origin header;
        // enabling the allowlist must never break them.
        let policy = OriginPolicy::from_allowlist("https://app.example.com");
        assert!(policy.allows(None));
    }

    #[test]
    fn entries_are_trimmed_and_empty_entries_dropped() {
        let policy = OriginPolicy::from_allowlist("  https://a.example ,, https://b.example  ");
        assert!(policy.is_enabled());
        let entries = policy.entries();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0], "https://a.example");
        assert_eq!(entries[1], "https://b.example");
    }

    #[test]
    fn matching_is_exact_and_case_sensitive() {
        // Browsers lowercase scheme/host, so configured entries must be
        // written lowercase; a differently-cased header value does not match.
        let policy = OriginPolicy::from_allowlist("https://App.Example.com");
        assert!(!policy.allows(Some("https://app.example.com")));
        assert!(policy.allows(Some("https://App.Example.com")));
    }
}

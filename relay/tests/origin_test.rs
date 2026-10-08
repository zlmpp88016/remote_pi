//! Integration tests for the WS Origin allowlist and the subprotocol echo
//! (plano 69 W4).
//!
//! The allowlist gates only browser-style handshakes (those carrying an
//! `Origin` header). With the allowlist empty — the default — every origin is
//! accepted, preserving the relay's historical behaviour. Handshakes without
//! an `Origin` header (app, pi-extension, Cockpit) are accepted even when the
//! allowlist is active.

mod common;
use common::{connect_and_auth_with_headers, start_relay, start_relay_with_origin_policy};

use futures_util::StreamExt;
use relay::OriginPolicy;
use tokio_tungstenite::tungstenite::{Error, http};

const ALLOWED_ORIGIN: &str = "https://app.example.com";
const FOREIGN_ORIGIN: &str = "https://evil.example.com";

/// Asserts the connection stayed open (no frame, no close) for a short window.
async fn assert_connection_alive(mut ws: common::WsStream) {
    let quiet = tokio::time::timeout(tokio::time::Duration::from_millis(200), ws.next()).await;
    assert!(
        quiet.is_err(),
        "relay closed or wrote to an accepted connection: {quiet:?}"
    );
}

#[tokio::test]
async fn listed_origin_completes_handshake() {
    let port = start_relay_with_origin_policy(OriginPolicy::from_allowlist(ALLOWED_ORIGIN)).await;
    let (ws, _echoed, _peer) = connect_and_auth_with_headers(port, &[("Origin", ALLOWED_ORIGIN)])
        .await
        .expect("listed origin must complete the auth handshake");
    assert_connection_alive(ws).await;
}

#[tokio::test]
async fn unlisted_origin_is_rejected_with_403() {
    let port = start_relay_with_origin_policy(OriginPolicy::from_allowlist(ALLOWED_ORIGIN)).await;
    let error = match connect_and_auth_with_headers(port, &[("Origin", FOREIGN_ORIGIN)]).await {
        Ok(_) => panic!("unlisted origin must be refused before the upgrade"),
        Err(error) => error,
    };
    match error {
        Error::Http(response) => {
            assert_eq!(
                response.status(),
                http::StatusCode::FORBIDDEN,
                "unlisted origin must be refused with 403"
            );
        }
        other => panic!("expected an HTTP 403 rejection, got: {other:?}"),
    }
}

#[tokio::test]
async fn missing_origin_header_still_accepted_when_allowlist_active() {
    // Native clients (app, pi-extension, Cockpit) send no Origin header; an
    // active allowlist must not break them.
    let port = start_relay_with_origin_policy(OriginPolicy::from_allowlist(ALLOWED_ORIGIN)).await;
    let (ws, _echoed, _peer) = connect_and_auth_with_headers(port, &[])
        .await
        .expect("header-less native client must still be accepted");
    assert_connection_alive(ws).await;
}

#[tokio::test]
async fn empty_allowlist_accepts_any_origin() {
    // Default (unset/empty allowlist) preserves the historical behaviour:
    // every origin is accepted.
    let port = start_relay().await;
    let (ws, _echoed, _peer) = connect_and_auth_with_headers(port, &[("Origin", FOREIGN_ORIGIN)])
        .await
        .expect("empty allowlist must accept any origin");
    assert_connection_alive(ws).await;
}

#[tokio::test]
async fn echoes_negotiated_subprotocol() {
    let port = start_relay().await;
    let (ws, echoed, _peer) =
        connect_and_auth_with_headers(port, &[("Sec-WebSocket-Protocol", "remotepi, chat")])
            .await
            .expect("handshake with requested subprotocols must succeed");
    assert_eq!(
        echoed.as_deref(),
        Some("remotepi"),
        "relay must echo the first requested subprotocol in the 101"
    );
    assert_connection_alive(ws).await;
}

#[tokio::test]
async fn no_subprotocol_requested_means_no_echo() {
    let port = start_relay().await;
    let (_ws, echoed, _peer) = connect_and_auth_with_headers(port, &[])
        .await
        .expect("plain handshake must succeed");
    assert!(
        echoed.is_none(),
        "relay must not echo a subprotocol the client did not request"
    );
}

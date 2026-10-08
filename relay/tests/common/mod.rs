#![allow(dead_code)]

use std::net::SocketAddr;
use std::sync::Arc;

use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
use ed25519_dalek::{Signer, SigningKey};
use futures_util::{SinkExt, StreamExt};
use relay::{
    AppState, FirehoseMetrics, MeshAuthCache, MeshStore, OriginPolicy, PeerRegistry, PresenceManager,
    RoomManager, build_router,
};
use serde_json::json;
use tokio::net::TcpListener;
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async, tungstenite::Message, tungstenite::http,
};

pub type WsStream = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

/// Binds the unified relay (WS + `/health` + `/mesh`) on a random localhost
/// port and returns that port. Mesh storage is `:memory:` for these tests —
/// use the helper in `tests/mesh_test.rs` when you need a persistent DB.
///
/// Uses the default (empty) Origin policy: every origin is accepted — the
/// relay's historical behaviour.
pub async fn start_relay() -> u16 {
    start_relay_with_origin_policy(OriginPolicy::default()).await
}

/// Same as [`start_relay`], but with an explicit Origin allowlist injected
/// (no env var involved — tests never race over global state).
pub async fn start_relay_with_origin_policy(origin_policy: OriginPolicy) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let mesh = Arc::new(MeshStore::open_in_memory().unwrap());
    let presence = Arc::new(PresenceManager::new());
    let rooms = Arc::new(RoomManager::new());
    let metrics = Arc::new(FirehoseMetrics::new());
    let registry = Arc::new(PeerRegistry::new(
        presence.clone(),
        rooms.clone(),
        metrics.clone(),
    ));
    let mesh_auth = Arc::new(MeshAuthCache::new());
    let state = AppState {
        registry,
        presence,
        rooms,
        mesh,
        mesh_auth,
        metrics,
        origin_policy: Arc::new(origin_policy),
    };
    let app = build_router(state);
    tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await;
    });
    // Give axum a moment to start accepting.
    tokio::time::sleep(tokio::time::Duration::from_millis(20)).await;
    port
}

/// Connects using a caller-supplied key and room_id, completes the full auth handshake.
/// Returns (ws_stream, peer_id_b64).
pub async fn connect_and_auth_with_room(
    port: u16,
    sk: &SigningKey,
    room_id: &str,
) -> (WsStream, String) {
    let url = format!("ws://127.0.0.1:{port}");
    let (mut ws, _) = connect_async(&url).await.unwrap();

    let vk = sk.verifying_key();
    let pubkey_b64 = B64.encode(vk.to_bytes());

    ws.send(Message::text(
        json!({"type": "hello", "pubkey": pubkey_b64, "room_id": room_id}).to_string(),
    ))
    .await
    .unwrap();

    let challenge_msg = ws.next().await.unwrap().unwrap();
    let challenge_json: serde_json::Value =
        serde_json::from_str(challenge_msg.to_text().unwrap()).unwrap();
    let nonce_b64 = challenge_json["nonce"].as_str().unwrap();
    let nonce_arr: [u8; 32] = B64.decode(nonce_b64).unwrap().try_into().unwrap();

    let sig = sk.sign(&nonce_arr);
    ws.send(Message::text(
        json!({"type": "auth", "sig": B64.encode(sig.to_bytes())}).to_string(),
    ))
    .await
    .unwrap();

    tokio::time::sleep(tokio::time::Duration::from_millis(30)).await;

    (ws, pubkey_b64)
}

/// Connects with a caller-supplied key, defaults to room "main".
pub async fn connect_and_auth_with_key(port: u16, sk: &SigningKey) -> (WsStream, String) {
    connect_and_auth_with_room(port, sk, "main").await
}

/// Connects with a fresh random key, defaults to room "main".
pub async fn connect_and_auth(port: u16) -> (WsStream, String) {
    let sk = SigningKey::generate(&mut rand::thread_rng());
    connect_and_auth_with_key(port, &sk).await
}

/// Connects with extra request headers (e.g. `Origin`,
/// `Sec-WebSocket-Protocol`), completes the full auth handshake with a fresh
/// key and returns `(ws, echoed_subprotocol, peer_id_b64)`. `echoed_subprotocol`
/// is the `Sec-WebSocket-Protocol` value carried by the 101 response, if any.
/// Propagates the tungstenite error when the relay refuses the upgrade (e.g. an
/// origin outside the allowlist → 403 before the handshake).
pub async fn connect_and_auth_with_headers(
    port: u16,
    headers: &[(&str, &str)],
) -> Result<(WsStream, Option<String>, String), tokio_tungstenite::tungstenite::Error> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;

    let url = format!("ws://127.0.0.1:{port}");
    // `IntoClientRequest` (não `http::Request::builder`) é quem monta o
    // upgrade WS completo — sec-websocket-key/version, upgrade, connection.
    // Um Request montado à máquina chega ao relay sem o key e o handshake
    // morre com InvalidHeader("sec-websocket-key").
    let mut request = url.into_client_request()?;
    for (name, value) in headers {
        let header_name = http::header::HeaderName::from_bytes(name.as_bytes())
            .expect("nome de header de teste inválido");
        let header_value = http::header::HeaderValue::from_str(value)
            .expect("valor de header de teste inválido");
        request.headers_mut().insert(header_name, header_value);
    }
    let (mut ws, response) = connect_async(request).await?;
    let echoed_subprotocol = response
        .headers()
        .get(http::header::SEC_WEBSOCKET_PROTOCOL)
        .and_then(|value| value.to_str().ok())
        .map(String::from);

    let sk = SigningKey::generate(&mut rand::thread_rng());
    let vk = sk.verifying_key();
    let pubkey_b64 = B64.encode(vk.to_bytes());

    ws.send(Message::text(
        json!({"type": "hello", "pubkey": pubkey_b64, "room_id": "main"}).to_string(),
    ))
    .await
    .unwrap();

    let challenge_msg = ws.next().await.unwrap().unwrap();
    let challenge_json: serde_json::Value =
        serde_json::from_str(challenge_msg.to_text().unwrap()).unwrap();
    let nonce_b64 = challenge_json["nonce"].as_str().unwrap();
    let nonce_arr: [u8; 32] = B64.decode(nonce_b64).unwrap().try_into().unwrap();

    let sig = sk.sign(&nonce_arr);
    ws.send(Message::text(
        json!({"type": "auth", "sig": B64.encode(sig.to_bytes())}).to_string(),
    ))
    .await
    .unwrap();

    tokio::time::sleep(tokio::time::Duration::from_millis(30)).await;

    Ok((ws, echoed_subprotocol, pubkey_b64))
}

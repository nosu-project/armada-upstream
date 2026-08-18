//! Browser-side transport for webxdc realtime channels.
//!
//! Vector carries these frames over iroh-gossip; a browser cannot open UDP
//! sockets, so it runs the same stack relay-only, which is the mode Vector
//! configures deliberately anyway (`src-tauri/src/miniapps/realtime.rs`).
//!
//! Deliberately dumb. Everything the two clients must agree on byte for byte —
//! the topic id, the 36-byte frame trailer, the base32 of a node address —
//! lives in `src/lib/webxdcRealtime.ts`, where it is tested against Vector's
//! own Rust. This crate moves opaque bytes between peers and nothing else, so
//! the interop surface stays in one place instead of straddling a language
//! boundary.

use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Mutex;

use futures_util::StreamExt;
use iroh::endpoint::{QuicTransportConfig, VarInt};
use iroh::{Endpoint, EndpointAddr, RelayMode};
use iroh_gossip::api::{Event, GossipSender, JoinOptions};
use iroh_gossip::net::{Gossip, GOSSIP_ALPN};
use iroh_gossip::proto::TopicId;
use wasm_bindgen::prelude::*;

/// Vector's cap. A larger frame is dropped by the far side rather than
/// rejected, so refuse it here where the caller can still be told.
const MAX_MESSAGE_SIZE: usize = 128 * 1024;

fn err(e: impl std::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}

/// One joined topic: the send half, kept so `send`/`leave` can reach it.
struct Joined {
    sender: GossipSender,
}

#[wasm_bindgen]
pub struct RealtimeNode {
    endpoint: Endpoint,
    gossip: Gossip,
    joined: Rc<Mutex<HashMap<[u8; 32], Joined>>>,
}

#[wasm_bindgen]
impl RealtimeNode {
    /// Bind a relay-only endpoint and start gossip.
    ///
    /// `Minimal` supplies the crypto provider; without one `bind()` fails at
    /// runtime rather than at compile time. Address discovery stays off: it
    /// publishes IPs that a browser cannot use anyway, and on native it causes
    /// the path migration Vector's comments warn about.
    #[wasm_bindgen(constructor)]
    pub async fn new() -> Result<RealtimeNode, JsError> {
        // Vector's QUIC tuning, matched (src-tauri/src/miniapps/realtime.rs).
        // Its comment calls these hard-won, and a browser needs them at least as
        // much: a backgrounded tab has its timers throttled, so the default idle
        // timeout can retire a session the player believes is still open.
        //
        // Not matched: BBR3. Vector pins a `noq` git rev because the published
        // BBR3 underflows its inflight estimate when loss exceeds the threshold,
        // and pulling a forked QUIC stack into a browser bundle for a congestion
        // controller is a separate decision with a size cost attached.
        let transport_config = QuicTransportConfig::builder()
            .keep_alive_interval(std::time::Duration::from_secs(15))
            .max_idle_timeout(Some(
                std::time::Duration::from_secs(120)
                    .try_into()
                    .map_err(|_| JsError::new("idle timeout out of range"))?,
            ))
            .stream_receive_window(VarInt::from_u32(512 * 1024))
            .receive_window(VarInt::from_u32(2 * 1024 * 1024))
            .send_window(1_572_864)
            .max_concurrent_bidi_streams(VarInt::from_u32(256))
            .max_concurrent_uni_streams(VarInt::from_u32(256))
            .initial_rtt(std::time::Duration::from_millis(100))
            // Observed-address reports teach QUIC direct paths it then tries to
            // migrate to. A browser has none, so this is belt and braces here,
            // but it keeps both ends of the connection saying the same thing.
            .send_observed_address_reports(false)
            .receive_observed_address_reports(false)
            .build();

        let endpoint = Endpoint::builder(iroh::endpoint::presets::Minimal)
            .relay_mode(RelayMode::Default)
            .alpns(vec![GOSSIP_ALPN.to_vec()])
            .transport_config(transport_config)
            .bind()
            .await
            .map_err(err)?;
        // Wait for a relay ADDRESS, not merely for `online`: an advertisement
        // published without one names a node nobody can reach, and in a browser
        // there is no direct path to fall back on. Vector polls the same way.
        endpoint.online().await;
        for _ in 0..20 {
            if endpoint
                .addr()
                .addrs
                .iter()
                .any(|a| matches!(a, iroh::TransportAddr::Relay(_)))
            {
                break;
            }
            wasm_sleep(100).await;
        }
        let gossip = Gossip::builder()
            .max_message_size(MAX_MESSAGE_SIZE)
            .spawn(endpoint.clone());

        // Answer inbound connections. A browser cannot be dialled directly,
        // but it CAN be reached through its relay, and without this loop
        // nobody is listening: two peers dial each other, neither answers, and
        // both sides report a dial timeout while the relay socket sits there
        // happily passing traffic.
        let accept_ep = endpoint.clone();
        let accept_gossip = gossip.clone();
        wasm_bindgen_futures::spawn_local(async move {
            while let Some(incoming) = accept_ep.accept().await {
                let g = accept_gossip.clone();
                wasm_bindgen_futures::spawn_local(async move {
                    if let Ok(conn) = incoming.await {
                        if conn.alpn() == GOSSIP_ALPN {
                            let _ = g.handle_connection(conn).await;
                        }
                    }
                });
            }
        });

        Ok(RealtimeNode {
            endpoint,
            gossip,
            joined: Rc::new(Mutex::new(HashMap::new())),
        })
    }

    /// Our endpoint address as JSON. The caller base32s it into the
    /// `webxdc-node-addr` tag, matching Vector's `encode_node_addr`.
    #[wasm_bindgen(js_name = nodeAddrJson)]
    pub fn node_addr_json(&self) -> Result<String, JsError> {
        serde_json::to_string(&self.endpoint.addr()).map_err(err)
    }

    /// Our public key, hex. Frames carry it in the trailer, and the receiver
    /// uses it to drop its own echoes.
    #[wasm_bindgen(js_name = publicKeyHex)]
    pub fn public_key_hex(&self) -> String {
        self.endpoint.id().to_string()
    }

    /// Join a topic. `on_message` is called with each frame's raw bytes,
    /// trailer included, exactly as it arrived: this layer does not interpret
    /// them. `peer_addrs_json` bootstraps the mesh from peers we learned about
    /// over the signalling plane.
    pub async fn join(
        &self,
        topic_bytes: &[u8],
        peer_addrs_json: Vec<String>,
        on_message: js_sys::Function,
        on_event: Option<js_sys::Function>,
    ) -> Result<(), JsError> {
        let topic = topic_of(topic_bytes)?;
        if self.joined.lock().unwrap().contains_key(&topic.as_bytes().to_owned()) {
            return Ok(());
        }

        let peers: Vec<EndpointAddr> = peer_addrs_json
            .iter()
            .filter_map(|j| serde_json::from_str::<EndpointAddr>(j).ok())
            .collect();
        let peer_ids: Vec<_> = peers.iter().map(|p| p.id).collect();

        // Subscribe BEFORE dialling. Connecting first races the gossip actor:
        // messages arrive for a topic it has not registered yet and are lost.
        let gossip_topic = self
            .gossip
            .subscribe_with_opts(topic, JoinOptions::with_bootstrap(peer_ids))
            .await
            .map_err(err)?;

        for addr in peers {
            let ep = self.endpoint.clone();
            let g = self.gossip.clone();
            let ev = on_event.clone();
            wasm_bindgen_futures::spawn_local(async move {
                let id = addr.id;
                match ep.connect(addr, GOSSIP_ALPN).await {
                    Ok(conn) => {
                        report(&ev, &format!("dialled {}", short(&id.to_string())));
                        if let Err(e) = g.handle_connection(conn).await {
                            report(&ev, &format!("handle_connection failed: {e}"));
                        }
                    }
                    Err(e) => report(&ev, &format!("dial failed: {e}")),
                }
            });
        }

        let (sender, mut receiver) = gossip_topic.split();
        self.joined
            .lock()
            .unwrap()
            .insert(*topic.as_bytes(), Joined { sender: sender.clone() });

        wasm_bindgen_futures::spawn_local(async move {
            while let Some(event) = receiver.next().await {
                match event {
                    Ok(Event::Received(msg)) => {
                        let arr = js_sys::Uint8Array::from(&msg.content[..]);
                        let _ = on_message.call1(&JsValue::NULL, &arr);
                    }
                    Ok(Event::NeighborUp(peer)) => {
                        // A connection can exist without gossip associating it
                        // with our topic, which shows up as one-way traffic.
                        let _ = sender.join_peers(vec![peer]).await;
                        report(&on_event, &format!("neighbor up {}", short(&peer.to_string())));
                    }
                    Ok(Event::NeighborDown(peer)) => {
                        report(&on_event, &format!("neighbor down {}", short(&peer.to_string())));
                    }
                    Ok(_) => {}
                    Err(e) => {
                        report(&on_event, &format!("receiver ended: {e}"));
                        break;
                    }
                }
            }
        });
        Ok(())
    }

    /// Broadcast one frame, trailer and all. The caller builds it.
    pub async fn send(&self, topic_bytes: &[u8], frame: Vec<u8>) -> Result<(), JsError> {
        if frame.len() > MAX_MESSAGE_SIZE {
            return Err(JsError::new("frame exceeds the 128 KB gossip limit"));
        }
        let topic = topic_of(topic_bytes)?;
        let sender = {
            let joined = self.joined.lock().unwrap();
            joined
                .get(topic.as_bytes())
                .map(|j| j.sender.clone())
                .ok_or_else(|| JsError::new("not joined to that topic"))?
        };
        sender.broadcast(frame.into()).await.map_err(err)
    }

    /// Dial a peer we learned about after joining.
    #[wasm_bindgen(js_name = addPeer)]
    pub async fn add_peer(&self, topic_bytes: &[u8], peer_addr_json: &str) -> Result<(), JsError> {
        let topic = topic_of(topic_bytes)?;
        let addr: EndpointAddr = serde_json::from_str(peer_addr_json).map_err(err)?;
        let sender = {
            let joined = self.joined.lock().unwrap();
            joined.get(topic.as_bytes()).map(|j| j.sender.clone())
        };
        let Some(sender) = sender else {
            return Err(JsError::new("not joined to that topic"));
        };
        let id = addr.id;
        let ep = self.endpoint.clone();
        let g = self.gossip.clone();
        wasm_bindgen_futures::spawn_local(async move {
            if let Ok(conn) = ep.connect(addr, GOSSIP_ALPN).await {
                let _ = g.handle_connection(conn).await;
            }
        });
        sender.join_peers(vec![id]).await.map_err(err)
    }

    /// Leave a topic. Dropping every sender and receiver half is what actually
    /// frees it: gossip only cleans up when the last one goes, and a survivor
    /// makes the next subscribe to the same topic a broken duplicate.
    pub fn leave(&self, topic_bytes: &[u8]) -> Result<(), JsError> {
        let topic = topic_of(topic_bytes)?;
        self.joined.lock().unwrap().remove(topic.as_bytes());
        Ok(())
    }
}

/// `setTimeout` as a future. There is no tokio timer in a browser.
async fn wasm_sleep(ms: i32) {
    let (tx, rx) = futures_channel::oneshot::channel::<()>();
    let cb = Closure::once_into_js(move || {
        let _ = tx.send(());
    });
    if web_sys_set_timeout(&cb, ms).is_err() {
        return;
    }
    let _ = rx.await;
}

#[wasm_bindgen(inline_js = "export function web_sys_set_timeout(cb, ms) { setTimeout(cb, ms); }")]
extern "C" {
    #[wasm_bindgen(catch, js_name = web_sys_set_timeout)]
    fn web_sys_set_timeout(cb: &JsValue, ms: i32) -> Result<(), JsValue>;
}

fn report(cb: &Option<js_sys::Function>, msg: &str) {
    if let Some(f) = cb {
        let _ = f.call1(&JsValue::NULL, &JsValue::from_str(msg));
    }
}

fn short(s: &str) -> String {
    s.chars().take(16).collect()
}

fn topic_of(bytes: &[u8]) -> Result<TopicId, JsError> {
    let arr: [u8; 32] = bytes
        .try_into()
        .map_err(|_| JsError::new("topic id must be 32 bytes"))?;
    Ok(TopicId::from_bytes(arr))
}

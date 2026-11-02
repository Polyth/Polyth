#![no_main]
//! WebSocket frames on a Link stream, plus the optional raw-DEFLATE layer.
use libfuzzer_sys::fuzz_target;
use polyth_link_core::protocol::{
    decode_ws_frame, deflate_ws_payload, encode_ws_frame, inflate_ws_payload, WsFrameType,
};
use polyth_link_core::wire::link_kind_from_ws_opcode;

fuzz_target!(|bytes: &[u8]| {
    if let Ok((kind, payload, used)) = decode_ws_frame(bytes) {
        let encoded = encode_ws_frame(kind, payload).expect("a decoded frame encodes");
        assert_eq!(&encoded[..], &bytes[..used]);
    }

    // Untrusted compressed payloads: bounded output, never a panic.
    for kind in [WsFrameType::TextDeflate, WsFrameType::BinaryDeflate] {
        let _ = inflate_ws_payload(kind, bytes.to_vec(), true);
        assert!(inflate_ws_payload(kind, bytes.to_vec(), false).is_err());
    }
    if let Some(opcode) = bytes.first() {
        let _ = link_kind_from_ws_opcode(*opcode);
    }

    // Our own compression must always undo itself.
    let text_ok = std::str::from_utf8(bytes).is_ok();
    for (kind, valid) in [(WsFrameType::Text, text_ok), (WsFrameType::Binary, true)] {
        if !valid {
            continue;
        }
        let (sent_kind, sent) = deflate_ws_payload(kind, bytes.to_vec(), true);
        let (got_kind, got) = inflate_ws_payload(sent_kind, sent, true).expect("own deflate inflates");
        assert_eq!(got_kind, kind);
        assert_eq!(got, bytes);
    }
});

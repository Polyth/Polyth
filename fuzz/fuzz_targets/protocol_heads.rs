#![no_main]
//! Length-prefixed CBOR heads a peer device sends on a Link stream.
use libfuzzer_sys::fuzz_target;
use polyth_link_core::protocol::{
    decode_head, encode_head, validate_http_request_head, validate_websocket_open, ControlMessage,
    HttpRequestHeadV1, HttpResponseHeadV1, WebSocketOpenV1,
};
use polyth_link_core::LinkError;
use serde::{Deserialize, Serialize};

fn round_trip<T>(bytes: &[u8])
where
    T: Serialize + for<'de> Deserialize<'de> + PartialEq + std::fmt::Debug,
{
    let Ok((head, used)) = decode_head::<T>(bytes) else {
        return;
    };
    assert!(used <= bytes.len());
    match encode_head(&head) {
        Ok(encoded) => {
            let (again, len) = decode_head::<T>(&encoded).expect("an encoded head decodes");
            assert_eq!(again, head);
            assert_eq!(len, encoded.len());
        }
        Err(LinkError::RequestTooLarge) => {}
        Err(err) => panic!("a decoded head failed to encode: {err:?}"),
    }
}

fuzz_target!(|bytes: &[u8]| {
    round_trip::<ControlMessage>(bytes);
    round_trip::<HttpResponseHeadV1>(bytes);
    if let Ok((head, _)) = decode_head::<HttpRequestHeadV1>(bytes) {
        let _ = validate_http_request_head(&head);
    }
    if let Ok((open, _)) = decode_head::<WebSocketOpenV1>(bytes) {
        let _ = validate_websocket_open(&open);
    }
});

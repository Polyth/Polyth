#![no_main]
//! CBOR control messages of the numeric-code pairing handshake.
use libfuzzer_sys::fuzz_target;
use polyth_link_core::numeric_wire::{decode_numeric_message, encode_numeric_message};
use polyth_link_core::LinkError;

fuzz_target!(|payload: &[u8]| {
    let Ok(message) = decode_numeric_message(payload) else {
        return;
    };
    match encode_numeric_message(&message) {
        Ok(encoded) => assert_eq!(decode_numeric_message(&encoded), Ok(message)),
        Err(LinkError::RequestTooLarge) => {}
        Err(err) => panic!("a decoded message failed to encode: {err:?}"),
    }
});

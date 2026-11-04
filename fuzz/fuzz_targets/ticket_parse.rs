#![no_main]
//! Pairing ticket text from a QR code, a pasted link or a deep link.
use libfuzzer_sys::fuzz_target;
use polyth_link_core::ticket::{encode_pairing_ticket, parse_pairing_ticket};
use polyth_link_core::{decode_invite_secret, LinkError};

fuzz_target!(|raw: &str| {
    let Ok(ticket) = parse_pairing_ticket(raw) else {
        return;
    };
    assert!(decode_invite_secret(&ticket).is_ok());
    // Whatever parses must survive being written out and read back unchanged.
    let encoded = encode_pairing_ticket(&ticket).expect("a parsed ticket encodes");
    match parse_pairing_ticket(&encoded) {
        Ok(again) => assert_eq!(again, ticket),
        // The ticket may lapse between the two parses.
        Err(LinkError::PairingExpired) => {}
        Err(err) => panic!("re-parse of an encoded ticket failed: {err:?}"),
    }
});

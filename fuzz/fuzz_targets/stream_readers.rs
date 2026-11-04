#![no_main]
//! Length-prefixed readers that sit directly on a peer's stream.
use std::cell::RefCell;
use std::io::Cursor;

use libfuzzer_sys::fuzz_target;
use polyth_link_core::limits::Limits;
use polyth_link_core::numeric_wire::read_numeric;
use polyth_link_core::wire::{read_len_prefixed, ControlReader};

thread_local! {
    static RT: RefCell<tokio::runtime::Runtime> = RefCell::new(
        tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap(),
    );
}

fuzz_target!(|bytes: &[u8]| {
    RT.with(|rt| {
        rt.borrow().block_on(async {
            let max = Limits::v1().control_message_bytes;
            if let Ok(payload) = read_len_prefixed(&mut Cursor::new(bytes), max).await {
                assert!(payload.len() <= max);
                assert_eq!(&payload[..], &bytes[4..4 + payload.len()]);
            }
            let _ = read_numeric(&mut Cursor::new(bytes)).await;
            // Several back-to-back messages on one stream.
            let mut reader = ControlReader::new(Cursor::new(bytes));
            while reader.read().await.is_ok() {}
        });
    });
});

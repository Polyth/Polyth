#![no_main]
//! HTTP heads and bodies from a browser or the local server, parsed on the host.
use std::cell::RefCell;
use std::io::Cursor;

use libfuzzer_sys::fuzz_target;
use polyth_link_core::http_io::{copy_chunked_decoded, find_header_end, read_http_head};
use polyth_link_core::proxy::{sanitize_request_headers, sanitize_response_headers};

thread_local! {
    static RT: RefCell<tokio::runtime::Runtime> = RefCell::new(
        tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap(),
    );
}

fuzz_target!(|bytes: &[u8]| {
    RT.with(|rt| {
        rt.borrow().block_on(async {
            let max = 16 * 1024;
            if let Ok(head) = read_http_head(&mut Cursor::new(bytes), max).await {
                let end = find_header_end(bytes).expect("a parsed head ends in a blank line");
                assert_eq!(head.header_block, &bytes[..end]);
                let _ = head.content_length();
                let _ = head.transfer_encoding_chunked();
                let _ = head.is_websocket_upgrade();
                let _ = sanitize_request_headers(&head.headers);
                let _ = sanitize_response_headers(&head.headers);
            }
            let mut sink = Vec::new();
            let limit = 64 * 1024;
            if let Ok(total) = copy_chunked_decoded(&mut Cursor::new(bytes), &mut sink, limit).await {
                assert_eq!(total as usize, sink.len());
                assert!(total <= limit);
            }
        });
    });
});

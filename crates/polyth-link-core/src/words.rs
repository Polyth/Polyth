use sha2::{Digest, Sha256};

use crate::errors::LinkError;

pub const WORDLIST_VERSION: &str = "polyth-link-words-v1";

const RAW: &str = include_str!("wordlist_v1.txt");

fn words() -> Vec<&'static str> {
    RAW.lines().filter(|line| !line.is_empty()).collect()
}

/// Four-word safety phrase derived from the pairing transcript and client proof.
pub fn safety_phrase(
    transcript_hash: &[u8; 32],
    client_proof: &[u8; 32],
) -> Result<[String; 4], LinkError> {
    let list = words();
    if list.len() != 2048 {
        return Err(LinkError::TransportProtocolError);
    }
    let mut hasher = Sha256::new();
    hasher.update(b"polyth-link-safety-v1");
    hasher.update(transcript_hash);
    hasher.update(client_proof);
    let digest = hasher.finalize();
    let mut bits: u64 = 0;
    for byte in digest.iter().take(6) {
        bits = (bits << 8) | u64::from(*byte);
    }
    // 48 bits → four 11-bit indexes (44 bits used).
    let mut out = [String::new(), String::new(), String::new(), String::new()];
    for (i, slot) in out.iter_mut().enumerate() {
        let index = ((bits >> (33 - i * 11)) & 0x7FF) as usize;
        *slot = list[index].to_string();
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wordlist_is_fixed_2048() {
        assert_eq!(words().len(), 2048);
        assert_eq!(WORDLIST_VERSION, "polyth-link-words-v1");
        assert!(words().windows(2).all(|pair| pair[0] < pair[1]));
    }

    #[test]
    fn phrase_is_deterministic() {
        let a = safety_phrase(&[1u8; 32], &[2u8; 32]).unwrap();
        let b = safety_phrase(&[1u8; 32], &[2u8; 32]).unwrap();
        let c = safety_phrase(&[1u8; 32], &[3u8; 32]).unwrap();
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert!(a.iter().all(|word| words().contains(&word.as_str())));
    }
}

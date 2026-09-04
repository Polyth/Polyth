use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use crate::errors::LinkError;

/// Canonical Polyth Link timestamps are RFC 3339 UTC with second precision.
pub fn unix_ms_to_rfc3339(ms: u64) -> Result<String, LinkError> {
    let seconds = i64::try_from(ms / 1000).map_err(|_| LinkError::PairingInvalid)?;
    OffsetDateTime::from_unix_timestamp(seconds)
        .map_err(|_| LinkError::PairingInvalid)?
        .format(&Rfc3339)
        .map_err(|_| LinkError::PairingInvalid)
}

pub fn now_unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn parse_rfc3339_to_unix_ms(value: &str) -> Result<u64, LinkError> {
    let parsed = OffsetDateTime::parse(value, &Rfc3339).map_err(|_| LinkError::PairingInvalid)?;
    let seconds = parsed.unix_timestamp();
    if seconds < 0 {
        return Err(LinkError::PairingInvalid);
    }
    let millis = u64::try_from(seconds).map_err(|_| LinkError::PairingInvalid)? * 1000
        + u64::from(parsed.millisecond());
    Ok(millis)
}

pub fn constant_eq(left: &[u8], right: &[u8]) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .zip(right)
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc3339_round_trip_is_stable() {
        let encoded = unix_ms_to_rfc3339(1_704_067_200_000).unwrap();
        assert!(encoded.ends_with('Z') || encoded.contains('+'));
        let parsed = parse_rfc3339_to_unix_ms(&encoded).unwrap();
        assert_eq!(parsed / 1000, 1_704_067_200);
        assert!(constant_eq(b"abcd", b"abcd"));
        assert!(!constant_eq(b"abcd", b"abce"));
        assert!(!constant_eq(b"abc", b"abcd"));
    }
}

use rand::RngCore;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::errors::LinkError;
use crate::limits::Limits;
use crate::protocol::{decode_head, encode_head, ControlMessage, STREAM_CONTROL};

pub async fn write_all<W: AsyncWrite + Unpin>(
    writer: &mut W,
    bytes: &[u8],
) -> Result<(), LinkError> {
    writer
        .write_all(bytes)
        .await
        .map_err(|_| LinkError::TransportProtocolError)
}

pub async fn read_exact<R: AsyncRead + Unpin>(
    reader: &mut R,
    buf: &mut [u8],
) -> Result<(), LinkError> {
    reader
        .read_exact(buf)
        .await
        .map_err(|_| LinkError::TransportProtocolError)
        .map(|_| ())
}

pub async fn read_len_prefixed<R: AsyncRead + Unpin>(
    reader: &mut R,
    max: usize,
) -> Result<Vec<u8>, LinkError> {
    let mut header = [0u8; 4];
    read_exact(reader, &mut header).await?;
    let len = u32::from_be_bytes(header) as usize;
    if len > max {
        return Err(LinkError::RequestTooLarge);
    }
    let mut payload = vec![0u8; len];
    read_exact(reader, &mut payload).await?;
    Ok(payload)
}

pub async fn read_bounded_line<R: AsyncRead + Unpin>(
    reader: &mut R,
    pending: &mut Vec<u8>,
    max: usize,
) -> Result<Option<String>, LinkError> {
    loop {
        if let Some(newline) = pending.iter().position(|byte| *byte == b'\n') {
            if newline > max {
                return Err(LinkError::RequestTooLarge);
            }
            let rest = pending.split_off(newline + 1);
            pending.truncate(newline);
            let line = String::from_utf8(std::mem::replace(pending, rest))
                .map_err(|_| LinkError::TransportProtocolError)?;
            return Ok(Some(line));
        }
        if pending.len() > max {
            return Err(LinkError::RequestTooLarge);
        }
        let mut chunk = [0u8; 8192];
        let want = chunk.len().min(max + 1 - pending.len());
        let read = reader
            .read(&mut chunk[..want])
            .await
            .map_err(|_| LinkError::TransportProtocolError)?;
        if read == 0 {
            return if pending.is_empty() {
                Ok(None)
            } else {
                Err(LinkError::TransportProtocolError)
            };
        }
        pending.extend_from_slice(&chunk[..read]);
    }
}

pub async fn write_control<W: AsyncWrite + Unpin>(
    writer: &mut W,
    message: &ControlMessage,
) -> Result<(), LinkError> {
    let bytes = encode_head(message)?;
    write_all(writer, &bytes).await
}

pub async fn read_control<R: AsyncRead + Unpin>(
    reader: &mut R,
) -> Result<ControlMessage, LinkError> {
    let payload = read_len_prefixed(reader, Limits::v1().control_message_bytes).await?;
    let mut framed = Vec::with_capacity(4 + payload.len());
    framed.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    framed.extend_from_slice(&payload);
    decode_head::<ControlMessage>(&framed)
        .map(|(msg, _)| msg)
        .map_err(|_| LinkError::TransportProtocolError)
}

pub struct ControlReader<R> {
    inner: R,
    header: [u8; 4],
    header_read: usize,
    payload: Vec<u8>,
    payload_read: usize,
}

impl<R> ControlReader<R> {
    pub fn new(inner: R) -> Self {
        Self {
            inner,
            header: [0; 4],
            header_read: 0,
            payload: Vec::new(),
            payload_read: 0,
        }
    }

    pub fn into_inner(self) -> R {
        self.inner
    }
}

impl<R: AsyncRead + Unpin> ControlReader<R> {
    pub async fn read(&mut self) -> Result<ControlMessage, LinkError> {
        while self.header_read < self.header.len() {
            let read = self
                .inner
                .read(&mut self.header[self.header_read..])
                .await
                .map_err(|_| LinkError::TransportProtocolError)?;
            if read == 0 {
                return Err(LinkError::TransportProtocolError);
            }
            self.header_read += read;
        }
        if self.payload.is_empty() {
            let len = u32::from_be_bytes(self.header) as usize;
            if len > Limits::v1().control_message_bytes {
                return Err(LinkError::RequestTooLarge);
            }
            self.payload.resize(len, 0);
        }
        while self.payload_read < self.payload.len() {
            let read = self
                .inner
                .read(&mut self.payload[self.payload_read..])
                .await
                .map_err(|_| LinkError::TransportProtocolError)?;
            if read == 0 {
                return Err(LinkError::TransportProtocolError);
            }
            self.payload_read += read;
        }
        let payload = std::mem::take(&mut self.payload);
        self.header_read = 0;
        self.payload_read = 0;
        let mut framed = Vec::with_capacity(4 + payload.len());
        framed.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        framed.extend_from_slice(&payload);
        decode_head::<ControlMessage>(&framed)
            .map(|(message, _)| message)
            .map_err(|_| LinkError::TransportProtocolError)
    }
}

pub async fn write_stream_kind<W: AsyncWrite + Unpin>(
    writer: &mut W,
    kind: u8,
) -> Result<(), LinkError> {
    write_all(writer, &[kind]).await
}

pub async fn read_stream_kind<R: AsyncRead + Unpin>(reader: &mut R) -> Result<u8, LinkError> {
    let mut kind = [0u8; 1];
    read_exact(reader, &mut kind).await?;
    Ok(kind[0])
}

pub async fn open_control<W: AsyncWrite + Unpin>(writer: &mut W) -> Result<(), LinkError> {
    write_stream_kind(writer, STREAM_CONTROL).await
}

pub async fn copy_limited<R, W>(
    reader: &mut R,
    writer: &mut W,
    limit: u64,
) -> Result<u64, LinkError>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut remaining = limit;
    let mut buf = vec![0u8; 16 * 1024];
    let mut copied = 0u64;
    while remaining > 0 {
        let want = buf.len().min(remaining as usize);
        let n = reader
            .read(&mut buf[..want])
            .await
            .map_err(|_| LinkError::TransportOutcomeUnknown)?;
        if n == 0 {
            return Err(LinkError::TransportProtocolError);
        }
        writer
            .write_all(&buf[..n])
            .await
            .map_err(|_| LinkError::TransportOutcomeUnknown)?;
        copied += n as u64;
        remaining -= n as u64;
    }
    Ok(copied)
}

pub fn encode_ws_client_frame(opcode: u8, payload: &[u8]) -> Result<Vec<u8>, LinkError> {
    if payload.len() > Limits::v1().ws_message_bytes {
        return Err(LinkError::RequestTooLarge);
    }
    let mut mask = [0u8; 4];
    rand::thread_rng().fill_bytes(&mut mask);
    let mut out = Vec::with_capacity(14 + payload.len());
    out.push(0x80 | opcode);
    if payload.len() <= 125 {
        out.push(0x80 | payload.len() as u8);
    } else if payload.len() <= 65535 {
        out.push(0x80 | 126);
        out.extend_from_slice(&(payload.len() as u16).to_be_bytes());
    } else {
        out.push(0x80 | 127);
        out.extend_from_slice(&(payload.len() as u64).to_be_bytes());
    }
    out.extend_from_slice(&mask);
    for (i, byte) in payload.iter().enumerate() {
        out.push(byte ^ mask[i % 4]);
    }
    Ok(out)
}

pub fn ws_opcode_from_link(kind: crate::protocol::WsFrameType) -> u8 {
    match kind {
        crate::protocol::WsFrameType::Text => 1,
        crate::protocol::WsFrameType::Binary => 2,
        crate::protocol::WsFrameType::Close => 8,
        crate::protocol::WsFrameType::Ping => 9,
        crate::protocol::WsFrameType::Pong => 10,
    }
}

pub fn link_kind_from_ws_opcode(opcode: u8) -> Result<crate::protocol::WsFrameType, LinkError> {
    match opcode {
        1 => Ok(crate::protocol::WsFrameType::Text),
        2 => Ok(crate::protocol::WsFrameType::Binary),
        8 => Ok(crate::protocol::WsFrameType::Close),
        9 => Ok(crate::protocol::WsFrameType::Ping),
        10 => Ok(crate::protocol::WsFrameType::Pong),
        _ => Err(LinkError::TransportProtocolError),
    }
}

pub fn encode_ws_server_frame(opcode: u8, payload: &[u8]) -> Result<Vec<u8>, LinkError> {
    if payload.len() > Limits::v1().ws_message_bytes {
        return Err(LinkError::RequestTooLarge);
    }
    let mut out = Vec::with_capacity(10 + payload.len());
    out.push(0x80 | opcode);
    if payload.len() <= 125 {
        out.push(payload.len() as u8);
    } else if payload.len() <= 65535 {
        out.push(126);
        out.extend_from_slice(&(payload.len() as u16).to_be_bytes());
    } else {
        out.push(127);
        out.extend_from_slice(&(payload.len() as u64).to_be_bytes());
    }
    out.extend_from_slice(payload);
    Ok(out)
}

pub async fn read_rfc6455_frame<R: AsyncRead + Unpin>(
    reader: &mut R,
) -> Result<(crate::protocol::WsFrameType, Vec<u8>), LinkError> {
    let mut header = [0u8; 2];
    read_exact(reader, &mut header).await?;
    let opcode = header[0] & 0x0f;
    let masked = header[1] & 0x80 != 0;
    let mut len = (header[1] & 0x7f) as usize;
    if len == 126 {
        let mut ext = [0u8; 2];
        read_exact(reader, &mut ext).await?;
        len = u16::from_be_bytes(ext) as usize;
    } else if len == 127 {
        let mut ext = [0u8; 8];
        read_exact(reader, &mut ext).await?;
        len = u64::from_be_bytes(ext) as usize;
    }
    if len > Limits::v1().ws_message_bytes {
        return Err(LinkError::RequestTooLarge);
    }
    let mut mask = [0u8; 4];
    if masked {
        read_exact(reader, &mut mask).await?;
    }
    let mut payload = vec![0u8; len];
    read_exact(reader, &mut payload).await?;
    if masked {
        for (i, byte) in payload.iter_mut().enumerate() {
            *byte ^= mask[i % 4];
        }
    }
    let kind = link_kind_from_ws_opcode(opcode)?;
    if kind == crate::protocol::WsFrameType::Text && std::str::from_utf8(&payload).is_err() {
        return Err(LinkError::TransportProtocolError);
    }
    Ok((kind, payload))
}

pub async fn read_link_ws_frame<R: AsyncRead + Unpin>(
    reader: &mut R,
) -> Result<(crate::protocol::WsFrameType, Vec<u8>), LinkError> {
    let mut header = [0u8; 5];
    read_exact(reader, &mut header).await?;
    let kind = crate::protocol::WsFrameType::from_u8(header[0])?;
    let len = u32::from_be_bytes(header[1..5].try_into().unwrap()) as usize;
    if len > Limits::v1().ws_message_bytes {
        return Err(LinkError::RequestTooLarge);
    }
    let mut payload = vec![0u8; len];
    read_exact(reader, &mut payload).await?;
    if kind == crate::protocol::WsFrameType::Text && std::str::from_utf8(&payload).is_err() {
        return Err(LinkError::TransportProtocolError);
    }
    Ok((kind, payload))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::ControlMessage;
    use tokio::io::{duplex, AsyncWriteExt};

    #[tokio::test]
    async fn control_round_trip() {
        let mut buf = Vec::new();
        write_control(&mut buf, &ControlMessage::Ping { nonce: [7u8; 16] })
            .await
            .unwrap();
        let mut cursor = std::io::Cursor::new(buf);
        let decoded = read_control(&mut cursor).await.unwrap();
        assert_eq!(decoded, ControlMessage::Ping { nonce: [7u8; 16] });
    }

    #[test]
    fn oversized_len_prefix_is_rejected() {
        let mut encoded = (u32::MAX).to_be_bytes().to_vec();
        encoded.extend_from_slice(&[1, 2, 3]);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let mut cursor = std::io::Cursor::new(encoded);
            let err = read_len_prefixed(&mut cursor, 64).await.unwrap_err();
            assert_eq!(err, LinkError::RequestTooLarge);
        });
    }

    #[tokio::test]
    async fn bounded_lines_keep_partial_data_when_a_read_is_cancelled() {
        let (mut reader, mut writer) = duplex(64);
        writer.write_all(b"{\"id\":").await.unwrap();
        let mut pending = Vec::new();
        assert!(tokio::time::timeout(
            std::time::Duration::from_millis(5),
            read_bounded_line(&mut reader, &mut pending, 64),
        )
        .await
        .is_err());
        assert_eq!(pending, b"{\"id\":");
        writer.write_all(b"1}\n").await.unwrap();
        assert_eq!(
            read_bounded_line(&mut reader, &mut pending, 64)
                .await
                .unwrap(),
            Some("{\"id\":1}".into())
        );
    }

    #[tokio::test]
    async fn control_reader_survives_cancelled_reads() {
        let mut encoded = Vec::new();
        write_control(&mut encoded, &ControlMessage::Ping { nonce: [9u8; 16] })
            .await
            .unwrap();
        let (reader, mut writer) = duplex(256);
        writer.write_all(&encoded[..2]).await.unwrap();
        let mut reader = ControlReader::new(reader);
        tokio::select! {
            result = reader.read() => panic!("partial frame completed: {result:?}"),
            _ = tokio::time::sleep(std::time::Duration::from_millis(5)) => {}
        }
        writer.write_all(&encoded[2..]).await.unwrap();
        assert_eq!(
            reader.read().await.unwrap(),
            ControlMessage::Ping { nonce: [9u8; 16] }
        );
    }
}

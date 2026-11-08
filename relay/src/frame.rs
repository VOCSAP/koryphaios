use std::io::{self, Read, Write};

pub const MAX_PAYLOAD: usize = 16 * 1024 * 1024;
/// Largest payload accepted while the peer has not yet proven the shared key
/// (CHALLENGE, AUTH_OK) or just did (WELCOME).
pub const PRE_AUTH_MAX_PAYLOAD: usize = 64 * 1024;

pub const CHALLENGE: u8 = 0x01;
pub const AUTH: u8 = 0x02;
pub const AUTH_OK: u8 = 0x03;
pub const HELLO: u8 = 0x04;
pub const WELCOME: u8 = 0x05;
pub const MCP: u8 = 0x10;
pub const TICKET: u8 = 0x11;
pub const BYE: u8 = 0x12;
pub const PING: u8 = 0x13;
pub const PONG: u8 = 0x14;
pub const ERROR: u8 = 0x15;

pub fn encode(ty: u8, payload: &[u8]) -> io::Result<Vec<u8>> {
    if payload.len() > MAX_PAYLOAD {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "frame payload of {} bytes exceeds the {MAX_PAYLOAD} byte limit",
                payload.len()
            ),
        ));
    }
    let mut buf = Vec::with_capacity(5 + payload.len());
    buf.extend_from_slice(&((payload.len() + 1) as u32).to_le_bytes());
    buf.push(ty);
    buf.extend_from_slice(payload);
    Ok(buf)
}

pub fn write_frame<W: Write>(w: &mut W, ty: u8, payload: &[u8]) -> io::Result<()> {
    let buf = encode(ty, payload)?;
    w.write_all(&buf)?;
    w.flush()
}

pub fn read_frame<R: Read>(r: &mut R) -> io::Result<(u8, Vec<u8>)> {
    read_frame_max(r, MAX_PAYLOAD)
}

/// A frame whose declared payload exceeds `max_payload` is refused before any
/// of its body is read.
pub fn read_frame_max<R: Read>(r: &mut R, max_payload: usize) -> io::Result<(u8, Vec<u8>)> {
    let mut header = [0u8; 4];
    r.read_exact(&mut header)?;
    let len = u32::from_le_bytes(header) as usize;
    if len == 0 || len - 1 > max_payload {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("protocol violation: frame length {len} (limit {max_payload})"),
        ));
    }
    let mut ty = [0u8; 1];
    r.read_exact(&mut ty)?;
    let mut payload = vec![0u8; len - 1];
    r.read_exact(&mut payload)?;
    Ok((ty[0], payload))
}

//! AES-256-GCM framing of everything sent after AUTH_OK.
//!
//! Wire: `u32le L || C || tag(16)` with `C = AES-256-GCM(type(1) || payload)`
//! and `L = 1 + len(payload) + 16`. The four bytes of `L` are the AAD. The
//! 12-byte nonce is four zero bytes followed by the frame counter of that
//! direction as a big-endian u64; each direction has its own key and counts
//! from 0. A frame that fails authentication, has an impossible length or
//! reaches counter 2^48 ends the connection with no reply.

use std::io::{self, Read, Write};

use aes_gcm::aead::{AeadInOut, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};

use crate::frame::MAX_PAYLOAD;

const TAG: usize = 16;
pub const MIN_SEALED_LEN: usize = 1 + TAG;
pub const COUNTER_LIMIT: u64 = 1 << 48;

fn nonce_for(counter: u64) -> io::Result<Nonce<aes_gcm::aead::consts::U12>> {
    let mut bytes = [0u8; 12];
    bytes[4..].copy_from_slice(&counter.to_be_bytes());
    Nonce::try_from(&bytes[..]).map_err(|_| io::Error::other("nonce of the wrong size"))
}

fn cipher_for(key: &[u8]) -> io::Result<Aes256Gcm> {
    Aes256Gcm::new_from_slice(key)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "channel key is not 32 bytes"))
}

fn exhausted() -> io::Error {
    io::Error::other("sealed channel counter reached 2^48")
}

pub struct Sealer {
    cipher: Aes256Gcm,
    counter: u64,
}

impl Sealer {
    pub fn new(key: &[u8]) -> io::Result<Sealer> {
        Sealer::starting_at(key, 0)
    }

    pub fn starting_at(key: &[u8], counter: u64) -> io::Result<Sealer> {
        Ok(Sealer {
            cipher: cipher_for(key)?,
            counter,
        })
    }

    pub fn seal(&mut self, ty: u8, payload: &[u8]) -> io::Result<Vec<u8>> {
        if payload.len() > MAX_PAYLOAD {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "frame payload of {} bytes exceeds the {MAX_PAYLOAD} byte limit",
                    payload.len()
                ),
            ));
        }
        if self.counter >= COUNTER_LIMIT {
            return Err(exhausted());
        }
        let header = ((1 + payload.len() + TAG) as u32).to_le_bytes();
        let mut body = Vec::with_capacity(1 + payload.len() + TAG);
        body.push(ty);
        body.extend_from_slice(payload);
        self.cipher
            .encrypt_in_place(&nonce_for(self.counter)?, &header, &mut body)
            .map_err(|_| io::Error::other("sealing failed"))?;
        self.counter += 1;
        let mut wire = Vec::with_capacity(4 + body.len());
        wire.extend_from_slice(&header);
        wire.extend_from_slice(&body);
        Ok(wire)
    }

    pub fn write<W: Write>(&mut self, w: &mut W, ty: u8, payload: &[u8]) -> io::Result<()> {
        let wire = self.seal(ty, payload)?;
        w.write_all(&wire)?;
        w.flush()
    }
}

pub struct Opener {
    cipher: Aes256Gcm,
    counter: u64,
}

impl Opener {
    pub fn new(key: &[u8]) -> io::Result<Opener> {
        Opener::starting_at(key, 0)
    }

    pub fn starting_at(key: &[u8], counter: u64) -> io::Result<Opener> {
        Ok(Opener {
            cipher: cipher_for(key)?,
            counter,
        })
    }

    /// Reads one sealed frame whose payload is at most `max_payload` bytes.
    /// A length outside the allowed range is refused before the body is read.
    pub fn read_max<R: Read>(
        &mut self,
        r: &mut R,
        max_payload: usize,
    ) -> io::Result<(u8, Vec<u8>)> {
        if self.counter >= COUNTER_LIMIT {
            return Err(exhausted());
        }
        let mut header = [0u8; 4];
        r.read_exact(&mut header)?;
        let len = u32::from_le_bytes(header) as usize;
        if len < MIN_SEALED_LEN || len > max_payload + MIN_SEALED_LEN {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "sealed frame rejected: length {len} outside {MIN_SEALED_LEN}..={}",
                    max_payload + MIN_SEALED_LEN
                ),
            ));
        }
        let mut body = vec![0u8; len];
        r.read_exact(&mut body)?;
        self.cipher
            .decrypt_in_place(&nonce_for(self.counter)?, &header, &mut body)
            .map_err(|_| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    "sealed frame rejected: authentication failed",
                )
            })?;
        self.counter += 1;
        let payload = body.split_off(1);
        Ok((body[0], payload))
    }

    pub fn read<R: Read>(&mut self, r: &mut R) -> io::Result<(u8, Vec<u8>)> {
        self.read_max(r, MAX_PAYLOAD)
    }
}

//! SQLCipher 4 page decryption in pure Rust.
//!
//! Rekordbox 6/7 keep `master.db` as a SQLCipher 4 database (default
//! parameters). Linking SQLCipher itself would mean building OpenSSL (needs
//! Perl on Windows) and would swap the plain SQLite every other database in
//! this app uses, so instead we decrypt a *copy* of the file page by page into
//! an ordinary SQLite file and open that with the rusqlite we already have.
//!
//! Format (SQLCipher 4 defaults): page size 4096; key = PBKDF2-HMAC-SHA512
//! (256,000 iterations) of the passphrase with the first 16 bytes of the file
//! as salt; every page ends with a 16-byte IV and a 64-byte HMAC-SHA512
//! (reserve = 80); page content is AES-256-CBC without padding. The HMAC key
//! is PBKDF2-HMAC-SHA512 (2 iterations) of the page key with the salt XOR 0x3a,
//! and covers the encrypted bytes + IV + the little-endian page number. Page 1
//! has the salt in place of the 16-byte "SQLite format 3" header, and its
//! encrypted region starts at offset 16.
//!
//! Every HMAC is verified, so a wrong key, a torn copy (Rekordbox writing
//! while we copy) or a different SQLCipher version is an error, never silent
//! garbage.

use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::Path;

use aes::cipher::{block_padding::NoPadding, BlockDecryptMut, KeyIvInit};
use hmac::{Hmac, Mac};
use sha2::Sha512;

type Aes256CbcDec = cbc::Decryptor<aes::Aes256>;

pub const PAGE_SIZE: usize = 4096;
const SALT_LEN: usize = 16;
const IV_LEN: usize = 16;
const HMAC_LEN: usize = 64;
const RESERVE: usize = IV_LEN + HMAC_LEN;
const KDF_ITER: u32 = 256_000;
const SQLITE_MAGIC: &[u8; 16] = b"SQLite format 3\0";

/// The key every Rekordbox 6/7 install uses. It is a published constant (the
/// MIT-licensed `pyrekordbox` project documents it) and is the same on every
/// machine, so it protects nothing on the user's own disk; it just has to be
/// supplied as the SQLCipher passphrase.
pub const REKORDBOX_PASSPHRASE: &str = "402fd482c38817c35ffa8ffb8c7d93143b749e7d315df7a81732a1ff43608497";

pub struct Keys {
    enc: [u8; 32],
    mac: [u8; 32],
}

pub fn derive_keys(passphrase: &[u8], salt: &[u8]) -> Keys {
    let mut enc = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<Sha512>(passphrase, salt, KDF_ITER, &mut enc);
    let mac_salt: Vec<u8> = salt.iter().map(|b| b ^ 0x3a).collect();
    let mut mac = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<Sha512>(&enc, &mac_salt, 2, &mut mac);
    Keys { enc, mac }
}

fn page_hmac(keys: &Keys, authed: &[u8], pgno: u32) -> [u8; HMAC_LEN] {
    let mut m = <Hmac<Sha512> as Mac>::new_from_slice(&keys.mac).expect("hmac accepts any key length");
    m.update(authed);
    m.update(&pgno.to_le_bytes());
    let out = m.finalize().into_bytes();
    let mut a = [0u8; HMAC_LEN];
    a.copy_from_slice(&out);
    a
}

/// Decrypts one page into `out` (same length as `page`); `pgno` is 1-based.
fn decrypt_page(keys: &Keys, page: &[u8], pgno: u32, out: &mut [u8]) -> Result<(), String> {
    let start = if pgno == 1 { SALT_LEN } else { 0 };
    let enc_end = PAGE_SIZE - RESERVE;
    let iv = &page[enc_end..enc_end + IV_LEN];
    let stored = &page[enc_end + IV_LEN..];
    let expect = page_hmac(keys, &page[start..enc_end + IV_LEN], pgno);
    // Local file, no oracle to protect: a plain slice compare is fine.
    if stored != expect {
        return Err(format!(
            "page {pgno} failed its integrity check (wrong key, a torn copy, or an unsupported SQLCipher version)"
        ));
    }
    let mut buf = page[start..enc_end].to_vec();
    Aes256CbcDec::new_from_slices(&keys.enc, iv)
        .map_err(|e| e.to_string())?
        .decrypt_padded_mut::<NoPadding>(&mut buf)
        .map_err(|e| e.to_string())?;
    out.fill(0);
    if pgno == 1 {
        out[..SALT_LEN].copy_from_slice(SQLITE_MAGIC);
    }
    out[start..enc_end].copy_from_slice(&buf);
    Ok(())
}

/// Decrypts `src` (read-only) into a plain SQLite file at `dst`. Returns the
/// number of pages written. The WAL flag in the header is reset because the
/// copy has no `-wal` beside it.
pub fn decrypt_database(src: &Path, dst: &Path, passphrase: &str) -> Result<u32, String> {
    let f = File::open(src).map_err(|e| format!("Couldn't open {}: {e}", src.display()))?;
    let len = f.metadata().map_err(|e| e.to_string())?.len() as usize;
    if len < PAGE_SIZE || len % PAGE_SIZE != 0 {
        return Err("Not a SQLCipher 4 database (size isn't a whole number of 4096-byte pages)".into());
    }
    let mut r = BufReader::with_capacity(1 << 20, f);
    let mut page = vec![0u8; PAGE_SIZE];
    r.read_exact(&mut page).map_err(|e| e.to_string())?;
    if &page[..16] == SQLITE_MAGIC {
        return Err("This database isn't encrypted".into());
    }
    let keys = derive_keys(passphrase.as_bytes(), &page[..SALT_LEN]);

    let out_file = File::create(dst).map_err(|e| format!("Couldn't create {}: {e}", dst.display()))?;
    let mut w = BufWriter::with_capacity(1 << 20, out_file);
    let mut out = vec![0u8; PAGE_SIZE];
    let pages = (len / PAGE_SIZE) as u32;
    for pgno in 1..=pages {
        if pgno > 1 {
            r.read_exact(&mut page).map_err(|e| e.to_string())?;
        }
        decrypt_page(&keys, &page, pgno, &mut out)?;
        if pgno == 1 {
            // 18/19 = write/read format version; 2 means WAL, which would make
            // SQLite look for a -wal file that doesn't exist.
            out[18] = 1;
            out[19] = 1;
        }
        w.write_all(&out).map_err(|e| e.to_string())?;
    }
    w.flush().map_err(|e| e.to_string())?;
    Ok(pages)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use aes::cipher::BlockEncryptMut;
    type Aes256CbcEnc = cbc::Encryptor<aes::Aes256>;

    /// Test-only encryptor so decryption is exercised on a database we built,
    /// independent of the owner's files.
    pub fn encrypt_database(plain: &[u8], passphrase: &str, salt: [u8; 16]) -> Vec<u8> {
        let keys = derive_keys(passphrase.as_bytes(), &salt);
        let mut out = Vec::new();
        for (i, chunk) in plain.chunks(PAGE_SIZE).enumerate() {
            let pgno = i as u32 + 1;
            let start = if pgno == 1 { SALT_LEN } else { 0 };
            let enc_end = PAGE_SIZE - RESERVE;
            let mut p = chunk.to_vec();
            p.resize(PAGE_SIZE, 0);
            let iv: Vec<u8> = (0..IV_LEN).map(|k| (pgno as usize * 7 + k) as u8).collect();
            let mut body = p[start..enc_end].to_vec();
            let n = body.len();
            Aes256CbcEnc::new_from_slices(&keys.enc, &iv)
                .unwrap()
                .encrypt_padded_mut::<NoPadding>(&mut body, n)
                .unwrap();
            let mut page = vec![0u8; PAGE_SIZE];
            if pgno == 1 {
                page[..SALT_LEN].copy_from_slice(&salt);
            }
            page[start..enc_end].copy_from_slice(&body);
            page[enc_end..enc_end + IV_LEN].copy_from_slice(&iv);
            let mac = page_hmac(&keys, &page[start..enc_end + IV_LEN], pgno);
            page[enc_end + IV_LEN..].copy_from_slice(&mac);
            out.extend_from_slice(&page);
        }
        out
    }

    fn scratch(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("mtc-sqlcipher-{}-{name}", std::process::id()));
        let _ = std::fs::create_dir_all(&d);
        d
    }

    #[test]
    fn round_trips_a_real_sqlite_file_and_rejects_a_wrong_key() {
        let dir = scratch("rt");
        let plain = dir.join("plain.db");
        {
            let c = rusqlite::Connection::open(&plain).unwrap();
            c.pragma_update(None, "page_size", 4096).unwrap();
            c.execute_batch(
                "CREATE TABLE t(a INTEGER, b TEXT); BEGIN;
                 WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<2000)
                 INSERT INTO t SELECT i, 'row ' || i || ' ' || hex(randomblob(40)) FROM n; COMMIT;",
            )
            .unwrap();
        }
        let bytes = std::fs::read(&plain).unwrap();
        let enc = encrypt_database(&bytes, "secret", [9u8; 16]);
        let encp = dir.join("enc.db");
        std::fs::write(&encp, &enc).unwrap();

        let outp = dir.join("out.db");
        let pages = decrypt_database(&encp, &outp, "secret").unwrap();
        assert_eq!(pages as usize, bytes.len() / PAGE_SIZE);
        // The synthetic plain file uses the whole page (reserve 0), so only the
        // region SQLCipher actually encrypts is comparable; opening the result
        // with SQLite is covered by the real master.db test in rekordbox_db.
        let got = std::fs::read(&outp).unwrap();
        assert_eq!(got.len(), bytes.len());
        for (i, (g, p)) in got.chunks(PAGE_SIZE).zip(bytes.chunks(PAGE_SIZE)).enumerate() {
            let hi = PAGE_SIZE - RESERVE;
            let lo = if i == 0 { 20 } else { 0 };
            assert_eq!(&g[lo..hi], &p[lo..hi], "page {}", i + 1);
        }
        assert_eq!(&got[..16], SQLITE_MAGIC);

        let err = decrypt_database(&encp, &dir.join("bad.db"), "wrong").unwrap_err();
        assert!(err.contains("integrity"), "{err}");
        // A flipped byte in a later page is caught too.
        let mut torn = enc.clone();
        torn[PAGE_SIZE * 2 + 100] ^= 1;
        std::fs::write(dir.join("torn.db"), &torn).unwrap();
        assert!(decrypt_database(&dir.join("torn.db"), &dir.join("t2.db"), "secret").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn plain_files_are_refused() {
        let dir = scratch("plain");
        let p = dir.join("p.db");
        let mut b = vec![0u8; PAGE_SIZE];
        b[..16].copy_from_slice(SQLITE_MAGIC);
        std::fs::write(&p, b).unwrap();
        assert!(decrypt_database(&p, &dir.join("o.db"), "x").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

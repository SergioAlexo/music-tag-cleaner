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

use aes::cipher::{block_padding::NoPadding, BlockDecryptMut, BlockEncryptMut, KeyIvInit};
use hmac::{Hmac, Mac};
use sha2::Sha512;

type Aes256CbcDec = cbc::Decryptor<aes::Aes256>;
type Aes256CbcEnc = cbc::Encryptor<aes::Aes256>;

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

/// A fresh random 16-byte SQLCipher salt (only for databases that have none;
/// re-encrypting an existing file should reuse its original salt).
#[allow(dead_code)] // library only for now: no write path exists (see plans/v0.19/notes/F2a.md)
pub fn random_salt() -> [u8; SALT_LEN] {
    let mut s = [0u8; SALT_LEN];
    getrandom::fill(&mut s).expect("OS random source unavailable");
    s
}

/// Encrypts one plain page (`PAGE_SIZE` bytes, reserve area ignored) into
/// `out`, with a fresh random IV. Page 1 gets `salt` in place of the 16-byte
/// SQLite header. Mirrors `decrypt_page`: HMAC over encrypted bytes + IV + LE
/// page number, starting after the salt on page 1.
fn encrypt_page(keys: &Keys, plain: &[u8], pgno: u32, salt: &[u8; SALT_LEN], out: &mut [u8]) -> Result<(), String> {
    let start = if pgno == 1 { SALT_LEN } else { 0 };
    let enc_end = PAGE_SIZE - RESERVE;
    let mut iv = [0u8; IV_LEN];
    getrandom::fill(&mut iv).map_err(|e| format!("No random source for the page IV: {e}"))?;
    let mut body = plain[start..enc_end].to_vec();
    let n = body.len();
    Aes256CbcEnc::new_from_slices(&keys.enc, &iv)
        .map_err(|e| e.to_string())?
        .encrypt_padded_mut::<NoPadding>(&mut body, n)
        .map_err(|e| e.to_string())?;
    out.fill(0);
    if pgno == 1 {
        out[..SALT_LEN].copy_from_slice(salt);
    }
    out[start..enc_end].copy_from_slice(&body);
    out[enc_end..enc_end + IV_LEN].copy_from_slice(&iv);
    let mac = page_hmac(keys, &out[start..enc_end + IV_LEN], pgno);
    out[enc_end + IV_LEN..].copy_from_slice(&mac);
    Ok(())
}

/// Encrypts a plain SQLite file (as produced by `decrypt_database`: page size
/// 4096 and an 80-byte reserve per page) into a SQLCipher 4 file at `dst`.
/// `plain` is only read. Returns the number of pages written.
///
/// Refuses input whose reserve area isn't 80 zero bytes per page: SQLCipher
/// overwrites that area with IV + HMAC, so anything else would silently lose
/// data. Header bytes 18/19 are copied as given (decrypt resets them to 1; a
/// WAL database would need 2 restored by the caller).
#[allow(dead_code)]
pub fn encrypt_database(plain: &Path, dst: &Path, passphrase: &str, salt: [u8; SALT_LEN]) -> Result<u32, String> {
    let f = File::open(plain).map_err(|e| format!("Couldn't open {}: {e}", plain.display()))?;
    let len = f.metadata().map_err(|e| e.to_string())?.len() as usize;
    if len < PAGE_SIZE || len % PAGE_SIZE != 0 {
        return Err("Not a 4096-byte-page SQLite database".into());
    }
    let mut r = BufReader::with_capacity(1 << 20, f);
    let mut page = vec![0u8; PAGE_SIZE];
    r.read_exact(&mut page).map_err(|e| e.to_string())?;
    if &page[..16] != SQLITE_MAGIC {
        return Err("Input isn't a plain SQLite database".into());
    }
    if u16::from_be_bytes([page[16], page[17]]) as usize != PAGE_SIZE {
        return Err("Input page size isn't 4096".into());
    }
    if page[20] as usize != RESERVE {
        return Err(format!("Input reserves {} bytes per page, expected {RESERVE}", page[20]));
    }
    let keys = derive_keys(passphrase.as_bytes(), &salt);
    let out_file = File::create(dst).map_err(|e| format!("Couldn't create {}: {e}", dst.display()))?;
    let mut w = BufWriter::with_capacity(1 << 20, out_file);
    let mut out = vec![0u8; PAGE_SIZE];
    let pages = (len / PAGE_SIZE) as u32;
    for pgno in 1..=pages {
        if pgno > 1 {
            r.read_exact(&mut page).map_err(|e| e.to_string())?;
        }
        if page[PAGE_SIZE - RESERVE..].iter().any(|&b| b != 0) {
            return Err(format!("Page {pgno} has data in its reserved area; refusing to overwrite it"));
        }
        encrypt_page(&keys, &page, pgno, &salt, &mut out)?;
        w.write_all(&out).map_err(|e| e.to_string())?;
    }
    w.flush().map_err(|e| e.to_string())?;
    Ok(pages)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("mtc-sqlcipher-{}-{name}", std::process::id()));
        let _ = std::fs::create_dir_all(&d);
        d
    }

    /// Plain SQLite with an 80-byte reserve per page (what SQLCipher files
    /// look like once decrypted), built with SQLite's own reserve-bytes file
    /// control + VACUUM, so the result opens with the same rows.
    fn make_plain(path: &Path, rows: i64) {
        let c = rusqlite::Connection::open(path).unwrap();
        c.pragma_update(None, "page_size", 4096).unwrap();
        c.execute_batch("CREATE TABLE t(a INTEGER, b TEXT);").unwrap();
        let mut n: std::os::raw::c_int = RESERVE as std::os::raw::c_int;
        // SQLITE_FCNTL_RESERVE_BYTES = 38
        let rc = unsafe {
            rusqlite::ffi::sqlite3_file_control(
                c.handle(),
                b"main\0".as_ptr() as *const _,
                38,
                &mut n as *mut _ as *mut _,
            )
        };
        assert_eq!(rc, 0);
        c.execute_batch("VACUUM;").unwrap();
        c.execute_batch(&format!(
            "BEGIN; WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<{rows})
             INSERT INTO t SELECT i, 'row ' || i || ' ' || hex(randomblob(40)) FROM n; COMMIT;"
        ))
        .unwrap();
        let _ = c.close();
        let b = std::fs::read(path).unwrap();
        assert_eq!(b[20] as usize, RESERVE, "reserve not applied");
    }

    fn page_ivs(enc: &[u8]) -> Vec<Vec<u8>> {
        let e = PAGE_SIZE - RESERVE;
        enc.chunks(PAGE_SIZE).map(|p| p[e..e + IV_LEN].to_vec()).collect()
    }

    #[test]
    fn encrypt_then_decrypt_is_byte_identical() {
        let dir = scratch("rt");
        let plain = dir.join("plain.db");
        make_plain(&plain, 2000);
        let bytes = std::fs::read(&plain).unwrap();
        let encp = dir.join("enc.db");
        let pages = encrypt_database(&plain, &encp, "secret", [9u8; 16]).unwrap();
        assert_eq!(pages as usize, bytes.len() / PAGE_SIZE);
        let enc = std::fs::read(&encp).unwrap();
        assert_eq!(enc.len(), bytes.len());
        assert_eq!(&enc[..16], &[9u8; 16], "page 1 starts with the salt");

        let outp = dir.join("out.db");
        decrypt_database(&encp, &outp, "secret").unwrap();
        let got = std::fs::read(&outp).unwrap();
        // Decrypt resets the WAL flag bytes; the plain file is rollback-journal
        // mode so they're already 1.
        assert_eq!(got, bytes);
        let c = rusqlite::Connection::open(&outp).unwrap();
        let n: i64 = c.query_row("SELECT count(*) FROM t", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 2000);
        let ic: String = c.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
        assert_eq!(ic, "ok");
        drop(c);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ivs_are_random_per_encryption_and_per_page() {
        let dir = scratch("iv");
        let plain = dir.join("plain.db");
        make_plain(&plain, 500);
        let bytes = std::fs::read(&plain).unwrap();
        let (a, b) = (dir.join("a.db"), dir.join("b.db"));
        encrypt_database(&plain, &a, "secret", [3u8; 16]).unwrap();
        encrypt_database(&plain, &b, "secret", [3u8; 16]).unwrap();
        let (ea, eb) = (std::fs::read(&a).unwrap(), std::fs::read(&b).unwrap());
        assert_ne!(ea, eb);
        let (ia, ib) = (page_ivs(&ea), page_ivs(&eb));
        assert!(ia.iter().zip(&ib).all(|(x, y)| x != y), "every page IV differs between runs");
        let uniq: std::collections::HashSet<_> = ia.iter().collect();
        assert_eq!(uniq.len(), ia.len(), "IVs unique within a file");
        for (e, name) in [(&a, "da.db"), (&b, "db.db")] {
            let o = dir.join(name);
            decrypt_database(e, &o, "secret").unwrap();
            assert_eq!(std::fs::read(&o).unwrap(), bytes);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn wrong_key_and_flipped_bytes_fail_the_hmac() {
        let dir = scratch("neg");
        let plain = dir.join("plain.db");
        make_plain(&plain, 1500);
        let encp = dir.join("enc.db");
        encrypt_database(&plain, &encp, "secret", [5u8; 16]).unwrap();
        let err = decrypt_database(&encp, &dir.join("bad.db"), "wrong").unwrap_err();
        assert!(err.contains("integrity"), "{err}");
        let enc = std::fs::read(&encp).unwrap();
        // Flip one byte in: page-1 body, a later page body, an IV, an HMAC.
        for off in [100usize, PAGE_SIZE * 2 + 100, PAGE_SIZE * 2 + (PAGE_SIZE - RESERVE) + 3, PAGE_SIZE * 3 - 1] {
            let mut torn = enc.clone();
            torn[off] ^= 1;
            let tp = dir.join("torn.db");
            std::fs::write(&tp, &torn).unwrap();
            let e = decrypt_database(&tp, &dir.join("t2.db"), "secret").unwrap_err();
            assert!(e.contains("integrity"), "offset {off}: {e}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn encrypt_refuses_inputs_it_would_corrupt() {
        let dir = scratch("refuse");
        // A stock SQLite file has no reserve, so its last 80 bytes are data.
        let p = dir.join("stock.db");
        {
            let c = rusqlite::Connection::open(&p).unwrap();
            c.pragma_update(None, "page_size", 4096).unwrap();
            c.execute_batch("CREATE TABLE t(a); INSERT INTO t VALUES (1);").unwrap();
        }
        assert!(encrypt_database(&p, &dir.join("o.db"), "x", [0; 16]).is_err());
        // Non-zero data inside the reserve of a later page.
        let q = dir.join("dirty.db");
        make_plain(&q, 500);
        let mut b = std::fs::read(&q).unwrap();
        b[PAGE_SIZE * 2 - 1] = 7;
        std::fs::write(&q, &b).unwrap();
        let e = encrypt_database(&q, &dir.join("o2.db"), "x", [0; 16]).unwrap_err();
        assert!(e.contains("reserved"), "{e}");
        // Already-encrypted input isn't plain.
        let r = dir.join("r.db");
        make_plain(&r, 10);
        encrypt_database(&r, &dir.join("e.db"), "x", [1; 16]).unwrap();
        assert!(encrypt_database(&dir.join("e.db"), &dir.join("o3.db"), "x", [0; 16]).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Round trip on a COPY of the owner's real master.db: decrypt -> encrypt
    /// with the original salt -> decrypt must give identical plain bytes.
    /// Read-only on the live file (std::fs::copy); writes only to a temp dir.
    /// Skips silently where Rekordbox isn't installed (CI).
    #[test]
    fn real_master_db_copy_round_trips() {
        let Some(live) = super::super::rekordbox_db::default_db_path() else {
            eprintln!("no Rekordbox master.db here; skipping");
            return;
        };
        let dir = std::env::temp_dir().join(format!("mtc-f2a-real-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let copy = dir.join("master.db");
        std::fs::copy(&live, &copy).unwrap();
        for sfx in ["-wal", "-shm"] {
            let mut side = live.clone().into_os_string();
            side.push(sfx);
            let side = std::path::PathBuf::from(side);
            if side.is_file() {
                let mut dst = copy.clone().into_os_string();
                dst.push(sfx);
                std::fs::copy(&side, std::path::PathBuf::from(dst)).unwrap();
            }
        }
        let mut salt = [0u8; SALT_LEN];
        salt.copy_from_slice(&std::fs::read(&copy).unwrap()[..SALT_LEN]);

        let plain1 = dir.join("plain1.db");
        let pages = decrypt_database(&copy, &plain1, REKORDBOX_PASSPHRASE).unwrap();
        let enc2 = dir.join("re-encrypted.db");
        assert_eq!(encrypt_database(&plain1, &enc2, REKORDBOX_PASSPHRASE, salt).unwrap(), pages);
        let plain2 = dir.join("plain2.db");
        decrypt_database(&enc2, &plain2, REKORDBOX_PASSPHRASE).unwrap();
        let (a, b) = (std::fs::read(&plain1).unwrap(), std::fs::read(&plain2).unwrap());
        assert!(a == b, "re-decrypted plain bytes differ");
        assert_ne!(std::fs::read(&copy).unwrap(), std::fs::read(&enc2).unwrap(), "fresh IVs");

        let tracks = |p: &Path| -> (i64, String) {
            let c = rusqlite::Connection::open_with_flags(p, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
            let n = c.query_row("SELECT count(*) FROM djmdContent", [], |r| r.get(0)).unwrap();
            let ic = c.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
            (n, ic)
        };
        let (n1, _) = tracks(&plain1);
        let (n2, ic2) = tracks(&plain2);
        eprintln!("real master.db copy: {pages} pages, {n1} tracks -> {n2} after re-encrypt, integrity_check {ic2}");
        assert_eq!(n1, n2);
        assert_eq!(ic2, "ok");
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

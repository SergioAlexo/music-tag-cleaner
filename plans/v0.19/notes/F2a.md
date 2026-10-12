# F2a - SQLCipher 4 encrypt (library + tests only)

## What was built
- `src-tauri/src/commands/sqlcipher.rs`: `encrypt_database(plain, dst, passphrase, salt) -> pages`, `random_salt()`, private `encrypt_page`. Mirror of the decrypt side: `derive_keys` reused (PBKDF2-HMAC-SHA512 256000 iters, HMAC key = 2 iters over salt^0x3a), 4096-byte pages, AES-256-CBC no padding, fresh 16-byte IV per page from `getrandom` (already a dependency), 80-byte reserve = IV + HMAC-SHA512 over (encrypted bytes + IV + LE page number), page 1 salt replaces the 16-byte header and the MAC/cipher regions start at offset 16.
- Guards: input must be a plain SQLite file, page size 4096, header reserve byte (offset 20) == 80, and every page's last 80 bytes must be zero (otherwise encryption would silently drop data). Header bytes 18/19 are copied as-is (decrypt resets them to 1; WAL = 2 is the caller's job).
- No Tauri command, UI, setting, or caller. Nothing in the app opens/writes/renames/backs up anything under `%APPDATA%\Pioneer`. `encrypt_database`/`random_salt` carry `#[allow(dead_code)]`.
- The old test-only encryptor (deterministic IVs) was removed; tests use the real function.
- `Cargo.toml` unchanged: no new crates, the dev-profile `opt-level = 3` overrides (sha2, pbkdf2, hmac, aes, cbc) already cover everything used.

## Tests (all in `sqlcipher.rs`)
- `encrypt_then_decrypt_is_byte_identical`: rusqlite DB with an 80-byte reserve (SQLITE_FCNTL_RESERVE_BYTES + VACUUM), 2000 rows; decrypt(encrypt(x)) == x byte for byte, 2000 rows, integrity_check ok.
- `ivs_are_random_per_encryption_and_per_page`: two encryptions of one input differ, every page IV differs between runs and is unique within a file, both decrypt to the original bytes.
- `wrong_key_and_flipped_bytes_fail_the_hmac`: wrong key; one flipped byte in page-1 body, later body, an IV, an HMAC -> all "integrity" errors.
- `encrypt_refuses_inputs_it_would_corrupt`: stock SQLite (no reserve), dirty reserve area, already-encrypted input.
- `real_master_db_copy_round_trips`: copies (read-only) the owner's master.db (+ -wal/-shm if present) to a temp dir, decrypt -> encrypt with the original salt -> decrypt; plain bytes identical, ciphertext differs from the original (fresh IVs), integrity_check ok. Skips silently if absent. Only writes in its temp dir (removed afterwards).

## Evidence
- Real copy: 12259 pages, 4405 tracks -> 4405 after re-encrypt, `integrity_check` ok, plain bytes identical.
- `cargo test` (src-tauri): 234 passed, 0 failed, 13 ignored. `npm test` passes. `npm run build` ok.
- NOT proven: that SQLCipher itself / Rekordbox opens a file we encrypted. Our own decrypt is the only reader so far (it is verified against Rekordbox's real file, so the format mirror is strong evidence, not proof). A cheap extra check for a later step: open the re-encrypted copy with Python `sqlcipher3` (key as in C0).

## Write path - NOT built
A future, separately approved step would need:
1. Process check: refuse while `rekordbox.exe` runs (tasklist, as done for Mixxx).
2. WAL refusal: refuse if `master.db-wal`/`-shm` exist and are non-empty (decrypt ignores a WAL, so writing would drop its contents); restore header bytes 18/19 = 2 before encrypting, since the original DB is `journal_mode=wal`.
3. USN bookkeeping per C0: every added/changed row gets `rb_local_usn` from `agentRegistry.localUpdateCount` (`int_1`), incremented once per change; row IDs/UUIDs/Seq/TrackNo, `created_at`/`updated_at`, smart-list `Id` as signed int32.
4. `masterPlaylists6.xml` kept in sync (NODE per playlist, timestamps = `updated_at`).
5. Backup first (timestamped copy of `master.db` + `masterPlaylists6.xml`), write encrypted output to a temp file in the same folder, verify (re-decrypt, integrity_check, row counts, HMACs), then atomic replace; one-click restore.
6. Reuse the original salt.
7. Owner verification checklist: Rekordbox closed; try on a backed-up state first; a throwaway playlist appears; no "corrupt library" prompt; cloud sync behaves; restore works.

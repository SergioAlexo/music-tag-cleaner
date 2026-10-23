//! Removable-drive discovery for the FAT32 formatter.
//!
//! Everything here is read-only. The formatting itself lives behind a separate
//! command, and the rule this module exists to enforce is that the formatter
//! never trusts a drive letter handed to it by the UI: it re-runs
//! `list_removable_drives` at format time and refuses anything that isn't in
//! that list. A drive list can go stale between the user picking a target and
//! confirming it — a stick pulled out and a different one pushed in reuses the
//! letter — and the cost of getting that wrong is someone's data.

use serde::{Deserialize, Serialize};

/// A removable volume the formatter is willing to consider.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovableDrive {
    /// Drive letter without a colon, e.g. "D".
    pub letter: String,
    /// Volume label, empty when the drive has none.
    pub label: String,
    /// Current filesystem ("FAT32", "exFAT", "NTFS"), empty if unformatted.
    pub file_system: String,
    pub size_bytes: u64,
    /// True when the volume is past Windows' own 32 GB FAT32 ceiling, so the
    /// built-in tools would refuse it and only a real FAT32 writer will do.
    pub needs_large_fat32: bool,
}

/// What PowerShell's Get-Volume gives us, before validation.
#[derive(Deserialize)]
struct RawVolume {
    #[serde(rename = "DriveLetter")]
    drive_letter: Option<String>,
    #[serde(rename = "FileSystemLabel")]
    label: Option<String>,
    #[serde(rename = "FileSystem")]
    file_system: Option<String>,
    #[serde(rename = "Size")]
    size: Option<u64>,
    #[serde(rename = "DriveType")]
    drive_type: Option<String>,
}

/// Windows' own FAT32 ceiling. Above this `format.com` and `Format-Volume`
/// both refuse, which is exactly the case a DJ's 64 GB stick lands in.
pub const WINDOWS_FAT32_LIMIT: u64 = 32 * 1024 * 1024 * 1024;

/// The letter the running OS booted from, e.g. "C". Never formattable.
fn system_drive_letter() -> String {
    std::env::var("SystemDrive")
        .unwrap_or_else(|_| "C:".to_string())
        .trim_end_matches(':')
        .to_ascii_uppercase()
}

/// Every removable volume with a drive letter, system drive excluded.
///
/// Deliberately narrow: only `DriveType == Removable` is returned, so fixed
/// disks and network shares can never reach the formatter's UI in the first
/// place, and the system drive is filtered even though it should never report
/// as removable — belt and braces, because the failure is unrecoverable.
/// Turns Get-Volume's JSON into the drives the formatter will consider.
///
/// Split out from the PowerShell call so it can be tested, because the shape
/// is a trap: Windows PowerShell 5.1 has no `-AsArray`, and it serialises a
/// *single* result as a bare object rather than a one-element array. A machine
/// with one USB stick plugged in — the common case — therefore produces JSON
/// that a plain `Vec` deserialise rejects, while two sticks work fine.
fn parse_volume_json(stdout: &str, system: &str) -> Result<Vec<RemovableDrive>, String> {
    let text = stdout.trim();
    if text.is_empty() {
        return Ok(Vec::new());
    }
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("Could not read drive list: {e}"))?;
    let raw: Vec<RawVolume> = match value {
        serde_json::Value::Null => Vec::new(),
        serde_json::Value::Array(_) => {
            serde_json::from_value(value).map_err(|e| format!("Could not read drive list: {e}"))?
        }
        other => vec![
            serde_json::from_value(other).map_err(|e| format!("Could not read drive list: {e}"))?,
        ],
    };

    Ok(raw
        .into_iter()
        .filter(|v| v.drive_type.as_deref() == Some("Removable"))
        .filter_map(|v| {
            let letter = v
                .drive_letter?
                .trim()
                .trim_end_matches(':')
                .to_ascii_uppercase();
            if letter.len() != 1 || letter == system {
                return None;
            }
            let size = v.size.unwrap_or(0);
            Some(RemovableDrive {
                letter,
                label: v.label.unwrap_or_default(),
                file_system: v.file_system.unwrap_or_default(),
                size_bytes: size,
                needs_large_fat32: size > WINDOWS_FAT32_LIMIT,
            })
        })
        .collect())
}

/// Every removable volume with a drive letter, system drive excluded.
///
/// Deliberately narrow: only `DriveType == Removable` is returned, so fixed
/// disks and network shares can never reach the formatter's UI in the first
/// place, and the system drive is filtered even though it should never report
/// as removable — belt and braces, because the failure is unrecoverable.
#[cfg(windows)]
pub fn enumerate_removable() -> Result<Vec<RemovableDrive>, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let out = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-Volume | Where-Object { $_.DriveLetter } |              Select-Object DriveLetter,FileSystemLabel,FileSystem,Size,DriveType |              ConvertTo-Json -Compress",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("Could not list drives: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "Could not list drives: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    parse_volume_json(
        &String::from_utf8_lossy(&out.stdout),
        &system_drive_letter(),
    )
}

#[cfg(not(windows))]
pub fn enumerate_removable() -> Result<Vec<RemovableDrive>, String> {
    Err("Drive formatting is only supported on Windows".to_string())
}

#[tauri::command]
pub async fn list_removable_drives() -> Result<Vec<RemovableDrive>, String> {
    tauri::async_runtime::spawn_blocking(enumerate_removable)
        .await
        .map_err(|e| e.to_string())?
}

/// Resolves `letter` against a *freshly enumerated* drive list, or explains why
/// it must not be formatted. This is the gate every format path goes through;
/// callers must never act on a letter that hasn't come back through here.
pub fn resolve_formattable(letter: &str) -> Result<RemovableDrive, String> {
    let wanted = letter.trim().trim_end_matches(':').to_ascii_uppercase();
    if wanted.len() != 1 || !wanted.chars().next().unwrap().is_ascii_alphabetic() {
        return Err(format!("{letter:?} is not a drive letter"));
    }
    if wanted == system_drive_letter() {
        return Err(format!("{wanted}: is the system drive and cannot be formatted"));
    }
    enumerate_removable()?
        .into_iter()
        .find(|d| d.letter == wanted)
        .ok_or_else(|| {
            format!("{wanted}: is not a removable drive — it may have been unplugged, or it isn't removable")
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    // The aligning layer is the piece that makes raw-volume writes legal, so
    // the thing to prove is that an unaligned write straddling a sector
    // boundary reads back byte-for-byte.
    #[test]
    fn unaligned_writes_survive_the_sector_alignment() {
        let mut image = std::io::Cursor::new(vec![0u8; (SECTOR * 4) as usize]);
        {
            let mut dev = SectorAligned::new(&mut image).unwrap();
            dev.seek(SeekFrom::Start(500)).unwrap();
            // 24 bytes starting at 500 spans the end of sector 0 and the start
            // of sector 1 — the case a naive passthrough gets wrong.
            dev.write_all(b"BOUNDARY-CROSSING-BYTES!").unwrap();
            dev.seek(SeekFrom::Start(3)).unwrap();
            dev.write_all(b"head").unwrap();
            dev.flush().unwrap();
        }
        let mut dev = SectorAligned::new(&mut image).unwrap();
        let mut got = [0u8; 24];
        dev.seek(SeekFrom::Start(500)).unwrap();
        dev.read_exact(&mut got).unwrap();
        assert_eq!(&got, b"BOUNDARY-CROSSING-BYTES!");
        let mut head = [0u8; 4];
        dev.seek(SeekFrom::Start(3)).unwrap();
        dev.read_exact(&mut head).unwrap();
        assert_eq!(&head, b"head", "earlier sector must not be clobbered");
    }

    // End to end, against a file-backed image rather than a disk: format, then
    // mount what was written and read the label and type back out.
    #[test]
    fn format_fat32_produces_a_mountable_volume() {
        let image = std::io::Cursor::new(vec![0u8; 256 * 1024 * 1024]);
        let mut image = image;
        format_fat32_into(&mut image, "SERGIOALEXO").expect("format should succeed");

        image.seek(SeekFrom::Start(0)).unwrap();
        let fs = fatfs::FileSystem::new(&mut image, fatfs::FsOptions::new())
            .expect("formatted image must mount");
        assert_eq!(fs.fat_type(), fatfs::FatType::Fat32, "must be FAT32, not FAT16");
        assert_eq!(fs.volume_label().trim(), "SERGIOALEXO");

        // And it must actually be usable, not merely mountable.
        let root = fs.root_dir();
        root.create_file("TEST.TXT")
            .expect("should be able to create a file")
            .write_all(b"cdj")
            .expect("should be able to write");
        let names: Vec<String> = root
            .iter()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name())
            .collect();
        assert!(names.iter().any(|n| n == "TEST.TXT"), "got {names:?}");
    }

    // The device path uses `with_len`, because a raw volume handle rejects
    // SeekFrom::End. That means `seek(End)` has to be answered from the
    // supplied length — and fatfs seeks to the end itself to size the volume,
    // so getting this wrong formats the drive to the wrong capacity.
    #[test]
    fn with_len_answers_seek_end_without_touching_the_device() {
        let size = 256 * 1024 * 1024u64;
        let mut image = std::io::Cursor::new(vec![0u8; size as usize]);
        {
            let mut dev = SectorAligned::with_len(&mut image, size);
            assert_eq!(dev.seek(SeekFrom::End(0)).unwrap(), size);
            assert_eq!(dev.seek(SeekFrom::End(-512)).unwrap(), size - 512);
            assert_eq!(dev.seek(SeekFrom::Start(0)).unwrap(), 0);
        }
        // And a format driven purely by the supplied length still mounts.
        format_fat32_sized(&mut image, size, "SIZED").expect("format should succeed");
        image.seek(SeekFrom::Start(0)).unwrap();
        let fs = fatfs::FileSystem::new(&mut image, fatfs::FsOptions::new())
            .expect("image formatted via with_len must mount");
        assert_eq!(fs.fat_type(), fatfs::FatType::Fat32);
        assert_eq!(fs.volume_label().trim(), "SIZED");
    }

    /// Counts how many times the underlying device is actually written, which
    /// is the thing that costs seconds on a USB stick.
    struct CountingDevice {
        inner: std::io::Cursor<Vec<u8>>,
        writes: std::rc::Rc<std::cell::Cell<usize>>,
    }

    impl Write for CountingDevice {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.writes.set(self.writes.get() + 1);
            self.inner.write(buf)
        }
        fn flush(&mut self) -> io::Result<()> {
            self.inner.flush()
        }
    }
    impl Read for CountingDevice {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            self.inner.read(buf)
        }
    }
    impl Seek for CountingDevice {
        fn seek(&mut self, p: SeekFrom) -> io::Result<u64> {
            self.inner.seek(p)
        }
    }

    // Regression: writes used to go straight through one sector at a time, so
    // fatfs zeroing the FAT with its 512-byte buffer meant a device write per
    // 512 bytes. On a real 57 GB stick that is ~28,000 unbuffered USB writes
    // and the format looks like it has hung.
    #[test]
    fn sequential_writes_are_coalesced_instead_of_one_per_sector() {
        let writes = std::rc::Rc::new(std::cell::Cell::new(0usize));
        let size = 8 * 1024 * 1024usize;
        let dev = CountingDevice {
            inner: std::io::Cursor::new(vec![0u8; size]),
            writes: writes.clone(),
        };
        let mut aligned = SectorAligned::with_len(dev, size as u64);

        // Exactly what write_zeros does: 4 MiB in 512-byte pieces.
        let chunk = [0xABu8; 512];
        let pieces = (4 * 1024 * 1024) / 512;
        for _ in 0..pieces {
            aligned.write_all(&chunk).unwrap();
        }
        aligned.flush().unwrap();

        assert_eq!(pieces, 8192, "sanity: that is 8192 separate 512-byte writes");
        assert!(
            writes.get() <= 8,
            "4 MiB should reach the device in a handful of writes, took {}",
            writes.get()
        );

        // And the bytes must still be exactly right.
        aligned.seek(SeekFrom::Start(0)).unwrap();
        let mut got = vec![0u8; 4 * 1024 * 1024];
        aligned.read_exact(&mut got).unwrap();
        assert!(got.iter().all(|b| *b == 0xAB), "buffered data was corrupted");
    }

    #[test]
    fn labels_are_sanitised_rather_than_rejected() {
        let mut image = std::io::Cursor::new(vec![0u8; 256 * 1024 * 1024]);
        // Lowercase, punctuation and over-length all have to survive somehow:
        // FAT32 labels are 11 bytes of upper-case OEM characters.
        format_fat32_into(&mut image, "sergio's dj stick 2026").expect("format should succeed");
        image.seek(SeekFrom::Start(0)).unwrap();
        let fs = fatfs::FileSystem::new(&mut image, fatfs::FsOptions::new()).unwrap();
        let label = fs.volume_label();
        assert!(label.len() <= 11, "label must fit FAT32's 11 bytes: {label:?}");
        assert!(
            label.chars().all(|c| c.is_ascii_alphanumeric() || c == ' ' || c == '_' || c == '-'),
            "punctuation should be dropped, got {label:?}"
        );
        assert_eq!(label.trim(), label.trim().to_uppercase());
    }

    #[test]
    fn labels_lose_whatever_could_break_the_helper_command_line() {
        assert_eq!(fat32_label(r#"dj "stick"\"#), "DJ STICK");
        assert_eq!(fat32_label("sergio's dj stick 2026"), "SERGIOS DJ ");
        assert_eq!(fat32_label("cdj_usb-1"), "CDJ_USB-1");
    }

    #[test]
    fn a_single_volume_parses_even_though_powershell_omits_the_array() {
        // PS 5.1 emits a bare object when exactly one volume matches — the
        // common case of one USB stick plugged in.
        let one = r#"{"DriveLetter":"D","FileSystemLabel":"SERGIOALEXO","FileSystem":"FAT32","Size":61509074944,"DriveType":"Removable"}"#;
        let got = parse_volume_json(one, "C").expect("single object must parse");
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].letter, "D");
        assert_eq!(got[0].label, "SERGIOALEXO");
        assert!(
            got[0].needs_large_fat32,
            "57 GB is past Windows' own FAT32 ceiling"
        );
    }

    #[test]
    fn fixed_disks_and_the_system_drive_never_survive_the_filter() {
        let both = r#"[{"DriveLetter":"C","FileSystemLabel":"","FileSystem":"NTFS","Size":999066431488,"DriveType":"Fixed"},{"DriveLetter":"D","FileSystemLabel":"SERGIOALEXO","FileSystem":"FAT32","Size":61509074944,"DriveType":"Removable"}]"#;
        let got = parse_volume_json(both, "C").expect("array must parse");
        assert_eq!(got.len(), 1, "only the removable volume should survive");
        assert_eq!(got[0].letter, "D");

        // Even a drive that wrongly reports as Removable is dropped when it is
        // the system drive.
        let liar = r#"[{"DriveLetter":"C","FileSystemLabel":"","FileSystem":"NTFS","Size":999066431488,"DriveType":"Removable"}]"#;
        assert!(
            parse_volume_json(liar, "C").unwrap().is_empty(),
            "the system drive must never be offered, whatever it claims to be"
        );
    }

    #[test]
    fn no_volumes_is_empty_not_an_error() {
        assert!(parse_volume_json("", "C").unwrap().is_empty());
        assert!(parse_volume_json("   ", "C").unwrap().is_empty());
        assert!(parse_volume_json("null", "C").unwrap().is_empty());
    }

    // Regression: this shipped as `\.\D:` (one backslash short), which Windows
    // rejects with ERROR_INVALID_NAME — reported as "volume label syntax is
    // incorrect", which sounds like a bad drive rather than a bad string.
    #[test]
    fn device_path_is_the_win32_volume_form() {
        assert_eq!(device_path("D"), r"\\.\D:");
        // The UI may hand back either spelling; both must normalise.
        assert_eq!(device_path("D:"), r"\\.\D:");
        assert_eq!(device_path(" e "), r"\\.\e:");
        // Exactly four leading characters: backslash, backslash, dot, backslash.
        let p = device_path("F");
        assert!(p.starts_with(r"\\.\"), "bad prefix: {p:?}");
        assert!(!p.ends_with('\\'), "no trailing slash: {p:?}");
        assert_eq!(p.matches('\\').count(), 3, "expected 3 backslashes in {p:?}");
    }

    #[test]
    fn the_system_drive_is_never_formattable() {
        let sys = system_drive_letter();
        let err = resolve_formattable(&sys).expect_err("system drive must be refused");
        assert!(err.contains("system drive"), "unexpected refusal: {err}");
        // And with the colon spelling the UI might send.
        let err2 = resolve_formattable(&format!("{sys}:")).expect_err("must be refused with colon");
        assert!(err2.contains("system drive"), "unexpected refusal: {err2}");
    }

    #[test]
    fn junk_letters_are_refused_before_any_enumeration() {
        // Including the raw device path form: handing that straight through
        // must not be mistaken for a drive letter.
        for bad in ["", "  ", "DD", "1", r"\\.\C:", "*", r"C:\Windows", "D:extra"] {
            assert!(
                resolve_formattable(bad).is_err(),
                "{bad:?} should not resolve to a formattable drive"
            );
        }
    }

    #[test]
    fn the_windows_fat32_ceiling_is_32gb() {
        assert_eq!(WINDOWS_FAT32_LIMIT, 34_359_738_368);
    }
}

// ---------------------------------------------------------------------------
// FAT32 formatting
// ---------------------------------------------------------------------------

use std::io::{self, ErrorKind, Read, Seek, SeekFrom, Write};

/// Windows raw-volume I/O is only legal on whole sectors: a read or write to
/// `\\.\D:` must start on a sector boundary and cover whole sectors, or it
/// fails outright. 512 is the logical sector size Windows reports for every
/// USB stick worth formatting FAT32.
const SECTOR: u64 = 512;

/// Makes an arbitrary-offset, arbitrary-length stream out of a device that only
/// accepts whole sectors, by reading the affected sector, patching it and
/// writing it back.
///
/// `fatfs` writes wherever its structures happen to fall — a 512-byte boot
/// sector, then a two-byte field somewhere in the middle of the FAT — so
/// without this every format would fail on the first unaligned write. Each call
/// touches at most one sector and returns a short count; `write_all`/`read_exact`
/// loop, which keeps the logic simple enough to be obviously correct.
pub struct SectorAligned<T> {
    inner: T,
    pos: u64,
    len: u64,
    /// Pending bytes destined for `buf_start` onwards. Always contiguous, and
    /// `buf_start` is always sector-aligned.
    buf: Vec<u8>,
    buf_start: u64,
}

/// How much to accumulate before touching the device.
///
/// This is what makes formatting finish in seconds rather than minutes.
/// `fatfs::write_zeros` clears the FAT with a **512-byte** buffer in a loop —
/// on a 57 GB volume that is ~14 MB of FAT, or ~28,000 calls. Sent straight
/// through, each becomes its own seek plus a 512-byte unbuffered write to a USB
/// device, and the format appears to hang. Coalescing them into 1 MiB writes
/// turns those 28,000 device round-trips into about fourteen.
const WRITE_BUFFER: usize = 1024 * 1024;

impl<T: Read + Write + Seek> SectorAligned<T> {
    /// For anything whose length seeking can discover — a file-backed image
    /// (the tests' stand-in for a USB stick).
    #[cfg(test)]
    pub fn new(mut inner: T) -> io::Result<Self> {
        let len = inner.seek(SeekFrom::End(0))?;
        inner.seek(SeekFrom::Start(0))?;
        Ok(Self {
            inner,
            pos: 0,
            len,
            buf: Vec::new(),
            buf_start: 0,
        })
    }

    /// For a device whose length seeking *cannot* discover. A Windows raw
    /// volume handle rejects `SeekFrom::End` outright with
    /// ERROR_INVALID_PARAMETER, so the caller reads the size out of
    /// `IOCTL_DISK_GET_LENGTH_INFO` and passes it in.
    ///
    /// Once constructed, `seek(End)` is answered from this value rather than
    /// the device — which matters because `fatfs::format_volume` seeks to the
    /// end itself to work out how many sectors it has to lay out.
    pub fn with_len(inner: T, len: u64) -> Self {
        Self {
            inner,
            pos: 0,
            len,
            buf: Vec::new(),
            buf_start: 0,
        }
    }

    /// Reads the sector containing `self.pos`. A sector past the end of a
    /// sparse image reads as zeros rather than an error, so formatting a
    /// freshly created file works the same as formatting a device.
    fn load_sector(&mut self, start: u64) -> io::Result<[u8; SECTOR as usize]> {
        let mut sector = [0u8; SECTOR as usize];
        self.inner.seek(SeekFrom::Start(start))?;
        match self.inner.read_exact(&mut sector) {
            Ok(()) => {}
            Err(e) if e.kind() == ErrorKind::UnexpectedEof => sector = [0u8; SECTOR as usize],
            Err(e) => return Err(e),
        }
        Ok(sector)
    }

    /// Pushes the pending buffer to the device.
    ///
    /// Whole sectors go out in a single write; a trailing partial sector still
    /// needs the read-modify-write, since the device will not accept less than
    /// a sector.
    fn flush_buf(&mut self) -> io::Result<()> {
        if self.buf.is_empty() {
            return Ok(());
        }
        let start = self.buf_start;
        let whole = self.buf.len() / SECTOR as usize * SECTOR as usize;
        if whole > 0 {
            self.inner.seek(SeekFrom::Start(start))?;
            let pending = std::mem::take(&mut self.buf);
            let result = self.inner.write_all(&pending[..whole]);
            self.buf = pending;
            result?;
        }
        let tail = self.buf.len() - whole;
        if tail > 0 {
            let tail_start = start + whole as u64;
            let mut sector = self.load_sector(tail_start)?;
            sector[..tail].copy_from_slice(&self.buf[whole..]);
            self.inner.seek(SeekFrom::Start(tail_start))?;
            self.inner.write_all(&sector)?;
        }
        self.buf.clear();
        Ok(())
    }
}

impl<T: Read + Write + Seek> Read for SectorAligned<T> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        // Reads must see writes that are still sitting in the buffer — fatfs
        // writes the FAT and then reads it back to allocate the root cluster.
        self.flush_buf()?;
        let start = self.pos / SECTOR * SECTOR;
        let off = (self.pos - start) as usize;
        let n = buf.len().min(SECTOR as usize - off);
        let sector = self.load_sector(start)?;
        buf[..n].copy_from_slice(&sector[off..off + n]);
        self.pos += n as u64;
        Ok(n)
    }
}

impl<T: Read + Write + Seek> Write for SectorAligned<T> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        // Append to the pending run when this write carries straight on from
        // it. This is the path `write_zeros` takes 28,000 times in a row.
        let contiguous = !self.buf.is_empty() && self.pos == self.buf_start + self.buf.len() as u64;
        if contiguous {
            let room = WRITE_BUFFER - self.buf.len();
            let n = buf.len().min(room);
            self.buf.extend_from_slice(&buf[..n]);
            self.pos += n as u64;
            if self.buf.len() >= WRITE_BUFFER {
                self.flush_buf()?;
            }
            return Ok(n);
        }

        // Not contiguous: the pending run is finished with.
        self.flush_buf()?;

        // Starting on a sector boundary means no read-modify-write is needed,
        // so the run can be buffered as-is.
        if self.pos % SECTOR == 0 {
            self.buf_start = self.pos;
            let n = buf.len().min(WRITE_BUFFER);
            self.buf.extend_from_slice(&buf[..n]);
            self.pos += n as u64;
            if self.buf.len() >= WRITE_BUFFER {
                self.flush_buf()?;
            }
            return Ok(n);
        }

        // Unaligned start — patch the one sector it lands in. Rare: the volume
        // label entry and the odd FAT field.
        let start = self.pos / SECTOR * SECTOR;
        let off = (self.pos - start) as usize;
        let n = buf.len().min(SECTOR as usize - off);
        let mut sector = self.load_sector(start)?;
        sector[off..off + n].copy_from_slice(&buf[..n]);
        self.inner.seek(SeekFrom::Start(start))?;
        self.inner.write_all(&sector)?;
        self.pos += n as u64;
        Ok(n)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.flush_buf()?;
        self.inner.flush()
    }
}

impl<T: Read + Write + Seek> Seek for SectorAligned<T> {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        let target = match pos {
            SeekFrom::Start(n) => n as i128,
            SeekFrom::Current(d) => self.pos as i128 + d as i128,
            SeekFrom::End(d) => self.len as i128 + d as i128,
        };
        if target < 0 {
            return Err(io::Error::new(
                ErrorKind::InvalidInput,
                "seek before start of device",
            ));
        }
        self.pos = target as u64;
        Ok(self.pos)
    }
}

/// Writes a fresh FAT32 filesystem over `device`.
///
/// Split from all the Windows volume handling so it can be tested against a
/// file-backed image instead of a real disk — the formatting logic is the part
/// that has to be right, and it should never need a USB stick to verify.
#[cfg(test)]
pub fn format_fat32_into<T: Read + Write + Seek>(device: T, label: &str) -> Result<(), String> {
    let dev = SectorAligned::new(device).map_err(|e| format!("Device not readable: {e}"))?;
    format_fat32_prepared(dev, label)
}

/// As `format_fat32_into`, for a device whose length had to be obtained out of
/// band — see `SectorAligned::with_len`.
pub fn format_fat32_sized<T: Read + Write + Seek>(
    device: T,
    len_bytes: u64,
    label: &str,
) -> Result<(), String> {
    format_fat32_prepared(SectorAligned::with_len(device, len_bytes), label)
}

/// What a FAT32 volume label can actually hold: up to 11 upper-case letters,
/// digits, spaces, `_` and `-`; anything else is dropped.
fn fat32_label(label: &str) -> String {
    label
        .to_ascii_uppercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '_' | '-'))
        .take(11)
        .collect()
}

fn format_fat32_prepared<T: Read + Write + Seek>(
    mut dev: SectorAligned<T>,
    label: &str,
) -> Result<(), String> {
    let mut label_bytes = [b' '; 11];
    for (slot, ch) in label_bytes.iter_mut().zip(fat32_label(label).bytes()) {
        *slot = ch;
    }
    let opts = fatfs::FormatVolumeOptions::new()
        .fat_type(fatfs::FatType::Fat32)
        .volume_label(label_bytes);
    fatfs::format_volume(&mut dev, opts).map_err(|e| format!("Format failed: {e}"))?;
    dev.flush().map_err(|e| format!("Flush failed: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Windows volume handling
// ---------------------------------------------------------------------------

/// Take exclusive ownership of the volume, so Windows isn't reading or writing
/// the filesystem we're about to replace underneath us.
#[cfg(windows)]
const FSCTL_LOCK_VOLUME: u32 = 0x0009_0018;
/// Detach the filesystem, so Windows re-reads it after we're done instead of
/// serving the old one from cache.
#[cfg(windows)]
const FSCTL_DISMOUNT_VOLUME: u32 = 0x0009_0020;
#[cfg(windows)]
const FSCTL_UNLOCK_VOLUME: u32 = 0x0009_001C;
/// Asks the volume how big it is. Needed because a raw volume handle refuses
/// `SeekFrom::End` with ERROR_INVALID_PARAMETER, so the size can't simply be
/// seeked for the way it can on a file.
#[cfg(windows)]
const IOCTL_DISK_GET_LENGTH_INFO: u32 = 0x0007_405C;

/// `GET_LENGTH_INFORMATION` — a single 64-bit byte count.
#[cfg(windows)]
#[repr(C)]
#[derive(Default)]
struct GetLengthInformation {
    length: i64,
}

/// Size of the volume behind `file`, in bytes.
#[cfg(windows)]
fn volume_length(file: &std::fs::File) -> Result<u64, String> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::IO::DeviceIoControl;

    let handle = HANDLE(file.as_raw_handle() as _);
    let mut info = GetLengthInformation::default();
    let mut returned: u32 = 0;
    // SAFETY: `handle` is a live volume handle owned by `file`, and the output
    // buffer is exactly the GET_LENGTH_INFORMATION this control code writes.
    unsafe {
        DeviceIoControl(
            handle,
            IOCTL_DISK_GET_LENGTH_INFO,
            None,
            0,
            Some(&mut info as *mut _ as *mut core::ffi::c_void),
            std::mem::size_of::<GetLengthInformation>() as u32,
            Some(&mut returned),
            None,
        )
    }
    .map_err(|e| format!("Could not read the volume size: {e}"))?;
    if info.length <= 0 {
        return Err("The volume reported a size of zero".to_string());
    }
    Ok(info.length as u64)
}

/// Win32 device path for a volume, e.g. `D` -> `\\.\D:`.
///
/// Trivial, and tested anyway: this shipped once as `\.\D:` — one backslash
/// short — and Windows reports that as ERROR_INVALID_NAME, "volume label syntax
/// is incorrect", which reads like a problem with the drive rather than with
/// the string we handed it.
fn device_path(letter: &str) -> String {
    format!(r"\\.\{}:", letter.trim().trim_end_matches(':'))
}

#[cfg(windows)]
fn fsctl(file: &std::fs::File, code: u32, what: &str) -> Result<(), String> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::IO::DeviceIoControl;

    let handle = HANDLE(file.as_raw_handle() as _);
    let mut returned: u32 = 0;
    // SAFETY: `handle` is a live volume handle owned by `file` for the whole
    // call, and both buffers are null with matching zero lengths, which is what
    // these three control codes expect.
    unsafe {
        DeviceIoControl(
            handle,
            code,
            None,
            0,
            None,
            0,
            Some(&mut returned),
            None,
        )
    }
    .map_err(|e| format!("Could not {what} the volume: {e}"))
}

/// Formats drive `letter` as FAT32. Requires Administrator — raw volume writes
/// are refused otherwise — so this runs in the elevated helper, not the UI
/// process.
///
/// Order matters: lock, then dismount, then write. Skipping the dismount leaves
/// Windows serving the old filesystem from cache and the drive looks unchanged
/// (or worse, half-changed) until replug.
#[cfg(windows)]
pub fn format_fat32_blocking(letter: &str, label: &str) -> Result<(), String> {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_SHARE_WRITE: u32 = 0x0000_0002;

    // Re-check against a fresh enumeration: never trust a letter handed in.
    let drive = resolve_formattable(letter)?;

    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        // The Win32 device path for a volume: `\\.\D:`, with no trailing
        // slash. Anything else — a plain "D:", or a stray backslash — fails
        // with ERROR_INVALID_NAME rather than anything that sounds like a path
        // problem, so `device_path` is unit-tested to keep it honest.
        .open(device_path(&drive.letter))
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::PermissionDenied {
                format!(
                    "Could not open {}: for writing — this needs Administrator rights ({e})",
                    drive.letter
                )
            } else {
                format!("Could not open {}: for writing ({e})", drive.letter)
            }
        })?;

    // Ask before locking: this is a plain query and a clearer error if it fails.
    let len = volume_length(&file)?;

    // The lock fails while anything has the drive open - by far the usual
    // reason being an Explorer window or a DJ app looking at it.
    fsctl(&file, FSCTL_LOCK_VOLUME, "lock").map_err(|e| {
        format!("{e}. Close any Explorer window or program using {}: (Rekordbox, a player) and try again.", drive.letter)
    })?;
    let dismounted = fsctl(&file, FSCTL_DISMOUNT_VOLUME, "dismount");
    let formatted = dismounted.and_then(|()| format_fat32_sized(&file, len, label));
    // Always give the volume back, even when the format failed part way.
    let _ = fsctl(&file, FSCTL_UNLOCK_VOLUME, "unlock");
    drop(file);
    formatted
}

#[cfg(not(windows))]
pub fn format_fat32_blocking(_letter: &str, _label: &str) -> Result<(), String> {
    Err("Drive formatting is only supported on Windows".to_string())
}

// ---------------------------------------------------------------------------
// Elevation
// ---------------------------------------------------------------------------

/// Argument that puts a fresh copy of the app into "format this drive and exit"
/// mode. Handled at the very top of `main`, before Tauri or the single-instance
/// plugin exist — otherwise the plugin would hand the arguments to the running
/// UI process and exit without ever formatting anything.
pub const FORMAT_HELPER_ARG: &str = "--format-fat32";

/// Runs the format and exits, when launched as the elevated helper. Returns
/// `None` in normal UI launches so `main` carries on.
///
/// The failure message goes to a file rather than stderr because the parent
/// can't read an elevated child's pipes — a `runas` launch gets a process
/// handle and an exit code, nothing more.
pub fn run_format_helper_if_requested() -> Option<i32> {
    let args: Vec<String> = std::env::args().collect();
    let at = args.iter().position(|a| a == FORMAT_HELPER_ARG)?;
    let letter = args.get(at + 1).cloned().unwrap_or_default();
    let label = args.get(at + 2).cloned().unwrap_or_default();
    let err_file = args.get(at + 3).cloned().unwrap_or_default();

    match format_fat32_blocking(&letter, &label) {
        Ok(()) => Some(0),
        Err(e) => {
            if !err_file.is_empty() {
                let _ = std::fs::write(&err_file, &e);
            }
            eprintln!("{e}");
            Some(1)
        }
    }
}

/// Relaunches this executable elevated to format `letter`, and waits for it.
///
/// `runas` is what raises the UAC prompt; the user can decline, which surfaces
/// as ERROR_CANCELLED and is reported as a plain cancellation rather than a
/// failure.
#[cfg(windows)]
fn run_elevated_format(letter: &str, label: &str) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, ERROR_CANCELLED, WAIT_OBJECT_0};
    use windows::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject, INFINITE};
    use windows::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};

    fn wide(s: &str) -> Vec<u16> {
        std::ffi::OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let err_file = std::env::temp_dir().join(format!(
        "mtc-format-{}.err",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&err_file);

    // Quoted, since it can contain spaces, and reduced to what FAT32 keeps
    // anyway first: a typed label ending in `\` turned the closing quote into
    // an escaped one, and the helper then read the label and error-file
    // arguments wrong.
    let params = format!(
        "{FORMAT_HELPER_ARG} {} \"{}\" \"{}\"",
        letter,
        fat32_label(label),
        err_file.display()
    );

    let verb = wide("runas");
    let file = wide(&exe.to_string_lossy());
    let args_w = wide(&params);

    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS,
        lpVerb: PCWSTR(verb.as_ptr()),
        lpFile: PCWSTR(file.as_ptr()),
        lpParameters: PCWSTR(args_w.as_ptr()),
        nShow: 0, // SW_HIDE — the helper has no window of its own.
        ..Default::default()
    };

    // SAFETY: every PCWSTR points at a wide buffer that outlives the call, and
    // cbSize matches the struct actually passed.
    unsafe { ShellExecuteExW(&mut info) }.map_err(|e| {
        if e.code().0 as u32 & 0xFFFF == ERROR_CANCELLED.0 {
            "Formatting needs Administrator rights, and the prompt was dismissed".to_string()
        } else {
            format!("Could not start the elevated formatter: {e}")
        }
    })?;

    let mut code: u32 = 1;
    // SAFETY: SEE_MASK_NOCLOSEPROCESS means hProcess is a handle we now own.
    unsafe {
        if WaitForSingleObject(info.hProcess, INFINITE) != WAIT_OBJECT_0 {
            let _ = CloseHandle(info.hProcess);
            return Err("Lost track of the formatter process".to_string());
        }
        let _ = GetExitCodeProcess(info.hProcess, &mut code);
        let _ = CloseHandle(info.hProcess);
    }

    if code == 0 {
        return Ok(());
    }
    let detail = std::fs::read_to_string(&err_file).unwrap_or_default();
    let _ = std::fs::remove_file(&err_file);
    Err(if detail.trim().is_empty() {
        format!("Formatting failed (exit code {code})")
    } else {
        detail.trim().to_string()
    })
}

#[cfg(not(windows))]
fn run_elevated_format(_letter: &str, _label: &str) -> Result<(), String> {
    Err("Drive formatting is only supported on Windows".to_string())
}

/// Formats a removable drive as FAT32, after checking the target is still what
/// the user confirmed.
///
/// `confirm` must repeat the drive's current label, or its letter when it has
/// none. That is not ceremony: drive letters get reused the moment one stick is
/// pulled and another pushed in, so a letter alone is not enough to know the
/// user is looking at the drive they think they are.
#[tauri::command]
pub async fn format_drive_fat32(
    letter: String,
    new_label: String,
    confirm: String,
) -> Result<(), String> {
    let drive = tauri::async_runtime::spawn_blocking({
        let letter = letter.clone();
        move || resolve_formattable(&letter)
    })
    .await
    .map_err(|e| e.to_string())??;

    let expected = if drive.label.trim().is_empty() {
        drive.letter.clone()
    } else {
        drive.label.trim().to_string()
    };
    if confirm.trim().to_ascii_uppercase() != expected.to_ascii_uppercase() {
        return Err(format!(
            "Type {expected:?} exactly to confirm — that is what {}: is called right now",
            drive.letter
        ));
    }

    tauri::async_runtime::spawn_blocking(move || run_elevated_format(&drive.letter, &new_label))
        .await
        .map_err(|e| e.to_string())?
}

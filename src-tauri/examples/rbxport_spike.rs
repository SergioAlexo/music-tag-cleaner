//! SPIKE: export one rekordbox.xml playlist to a CDJ-style USB layout with
//! rbxport's `rbl-export`, without Rekordbox.
//!
//! cargo run --release --example rbxport_spike -- <rekordbox.xml> <playlist name> <music dir> <dest dir>
//!
//! `<music dir>` remaps each track's Location by file name, because a
//! rekordbox.xml carries absolute paths from whichever PC exported it.
//! Metadata comes from the XML; beat grid, key fallback and the overview
//! waveform come from rbxport's own analyser.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Instant;

use quick_xml::events::Event;
use quick_xml::Reader;

#[derive(Default, Clone)]
struct XmlTrack {
    attrs: HashMap<String, String>,
}

impl XmlTrack {
    fn get(&self, k: &str) -> String {
        self.attrs.get(k).cloned().unwrap_or_default()
    }
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Collection tracks by TrackID, and the TrackIDs of the named playlist.
fn read_xml(path: &Path, playlist: &str) -> (HashMap<String, XmlTrack>, Vec<String>) {
    let mut reader = Reader::from_file(path).expect("open rekordbox.xml");
    let mut buf = Vec::new();
    let mut tracks = HashMap::new();
    let mut keys = Vec::new();
    let mut in_collection = false;
    let mut in_playlist = false;
    loop {
        match reader.read_event_into(&mut buf).expect("parse rekordbox.xml") {
            Event::Eof => break,
            Event::Start(e) | Event::Empty(e) => {
                let attrs: HashMap<String, String> = e
                    .attributes()
                    .flatten()
                    .map(|a| {
                        #[allow(deprecated)]
                        let v = a.unescape_value().map(|v| v.into_owned()).unwrap_or_default();
                        (a.key.as_ref().to_string(), v)
                    })
                    .collect();
                match e.name().as_ref() {
                    "COLLECTION" => in_collection = true,
                    "PLAYLISTS" => in_collection = false,
                    "NODE" => {
                        in_playlist = attrs.get("Type").map(String::as_str) == Some("1")
                            && attrs.get("Name").map(String::as_str) == Some(playlist);
                    }
                    "TRACK" if in_collection && attrs.contains_key("TrackID") => {
                        tracks.insert(attrs["TrackID"].clone(), XmlTrack { attrs });
                    }
                    "TRACK" if in_playlist => {
                        if let Some(k) = attrs.get("Key") {
                            keys.push(k.clone());
                        }
                    }
                    _ => {}
                }
            }
            Event::End(e) if e.name().as_ref() == "NODE" => in_playlist = false,
            _ => {}
        }
        buf.clear();
    }
    (tracks, keys)
}

fn analysis_dat(audio_path: &Path) -> Result<(Vec<u8>, Option<String>, f64, f64), String> {
    let audio = rbl_audio::decode_mono(audio_path, None).map_err(|e| e.to_string())?;
    let a = rbl_analysis::analyse(&audio.samples, audio.sample_rate);
    let beats: Vec<rbl_anlz::Beat> = a
        .tempo
        .beats
        .iter()
        .map(|b| rbl_anlz::Beat { beat_number: b.beat_number, tempo_x100: b.tempo_x100, time_ms: b.time_ms })
        .collect();
    // PWAV packs height in the low five bits and whiteness in the top three
    // (same encoding as rbxport's own pipeline test).
    let preview: Vec<u8> = a
        .waveform
        .columns
        .iter()
        .map(|c| {
            let height = u32::from(c.peak) * 31 / 255;
            let whiteness = u32::from(c.high) * 7 / 255;
            u8::try_from((whiteness << 5) | height).unwrap_or(0)
        })
        .collect();
    let mut b = rbl_anlz::AnlzBuilder::new();
    b.path(&audio_path.to_string_lossy()).beat_grid(&beats).waveform_preview(b"PWAV", &preview).empty_cue_list(false);
    Ok((b.finish(), a.key.map(|k| k.name), a.tempo.bpm, audio.duration_secs()))
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 5 {
        eprintln!("usage: rbxport_spike <rekordbox.xml> <playlist name> <music dir> <dest dir>");
        std::process::exit(2);
    }
    let (xml, playlist, music_dir, dest) =
        (Path::new(&args[1]), args[2].as_str(), Path::new(&args[3]), PathBuf::from(&args[4]));
    std::fs::create_dir_all(&dest).expect("create dest");

    let (collection, keys) = read_xml(xml, playlist);
    println!("playlist '{playlist}': {} entries, collection {} tracks", keys.len(), collection.len());

    let t0 = Instant::now();
    let mut sources = Vec::new();
    for key in &keys {
        let Some(t) = collection.get(key) else {
            println!("  ! TrackID {key} not in collection");
            continue;
        };
        let location = percent_decode(&t.get("Location"));
        let name = location.rsplit('/').next().unwrap_or_default().to_string();
        let path = music_dir.join(&name);
        if !path.is_file() {
            println!("  ! missing: {name}");
            continue;
        }
        let ta = Instant::now();
        let (analysis, detected_key, detected_bpm, dur) = match analysis_dat(&path) {
            Ok((dat, k, bpm, d)) => (vec![("DAT".to_string(), dat)], k, bpm, d),
            Err(e) => {
                println!("  ! analysis failed for {name}: {e}");
                (Vec::new(), None, 0.0, 0.0)
            }
        };
        let xml_bpm: f64 = t.get("AverageBpm").parse().unwrap_or(0.0);
        let bpm = if xml_bpm > 0.0 { xml_bpm } else { detected_bpm };
        let key = Some(t.get("Tonality")).filter(|k| !k.is_empty()).or(detected_key).unwrap_or_default();
        println!(
            "  {:<55} xml {:>6.2} / detected {:>6.2} BPM, key {:<4} ({} ms)",
            name.chars().take(55).collect::<String>(),
            xml_bpm,
            detected_bpm,
            key,
            ta.elapsed().as_millis()
        );
        let dur_xml: u16 = t.get("TotalTime").parse().unwrap_or(0);
        sources.push(rbl_export::SourceTrack {
            source_path: path,
            title: t.get("Name"),
            artist: t.get("Artist"),
            album: t.get("Album"),
            genre: t.get("Genre"),
            label: t.get("Label"),
            comment: t.get("Comments"),
            key,
            bpm_x100: (bpm * 100.0).round() as u32,
            duration_sec: if dur_xml > 0 { dur_xml } else { dur as u16 },
            year: t.get("Year").parse().unwrap_or(0),
            sample_rate: t.get("SampleRate").parse().unwrap_or(0),
            date_added: t.get("DateAdded"),
            analysis,
            ..Default::default()
        });
    }
    println!("analysed {} tracks in {:.1}s", sources.len(), t0.elapsed().as_secs_f64());

    let pl = rbl_export::SourcePlaylist {
        name: playlist.to_string(),
        track_indices: (0..sources.len()).collect(),
        ..Default::default()
    };
    let t1 = Instant::now();
    let report = rbl_export::export(&dest, &sources, &[pl]).expect("export");
    println!(
        "export: {} tracks, {} playlists, {} analysis files, {} MB copied, pdb {} bytes, oneLibrary {}, verified {}, {:.1}s",
        report.tracks,
        report.playlists,
        report.analysis_files,
        report.bytes_copied / 1_000_000,
        report.pdb_bytes,
        report.one_library,
        report.verified,
        t1.elapsed().as_secs_f64()
    );
    for w in &report.warnings {
        println!("  warning: {}: {} {:?}", w.title, w.reason, w.detail);
    }
    for f in report.failed.iter().chain(&report.skipped) {
        println!("  failed/skipped: {f}");
    }

    let check = rbl_export::verify(&dest).expect("verify");
    println!(
        "verify: ok={} tracks={} playlists={} entries={} audio={} analysis={} grids={} previews={} errors={:?} missing={:?}",
        check.is_ok(),
        check.tracks,
        check.playlists,
        check.playlist_entries,
        check.audio_present,
        check.analysis_present,
        check.beat_grids,
        check.overview_waveforms,
        check.errors,
        check.missing_audio
    );

    // Read export.pdb back the way a player would.
    let bytes = std::fs::read(dest.join("PIONEER/rekordbox/export.pdb")).expect("read export.pdb");
    let pdb = rbl_pdb::Pdb::parse(&bytes).expect("parse export.pdb");
    let rows = pdb.track_rows(pdb.table(rbl_pdb::PageType::Tracks).expect("tracks table"));
    for r in rows.iter().take(3) {
        println!("  pdb: {:?} {:.2} BPM -> {}", r.title, f64::from(r.tempo_x100) / 100.0, r.analyze_path);
    }
}

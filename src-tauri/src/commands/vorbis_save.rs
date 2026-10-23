//! Vorbis comment saves (FLAC, Ogg Vorbis, Opus, Speex) that keep the file's
//! own comment names.
//!
//! lofty edits every format through its generic `Tag`, and Vorbis comment names
//! don't survive that round trip: each name is read into an `ItemKey` and
//! written back under that key's first spelling. Any edit — a title, a rating —
//! came out with MIXARTIST renamed REMIXER (Traktor reads MIXARTIST), KEY
//! renamed INITIALKEY (VirtualDJ and Engine DJ read KEY), ORGANIZATION turned
//! into a second LABEL, TOTALTRACKS into TRACKTOTAL, and the encoder's vendor
//! string copied into a new ENCODER comment.
//!
//! A save here patches the comments the file already holds instead. A comment
//! the edit left alone is written back exactly as it was read; a new value of a
//! field takes the place and the name of the comment it replaces; only a field
//! the file never had is written under lofty's name for it.

use std::io::{Read, Seek};

use lofty::config::{ParseOptions, WriteOptions};
use lofty::file::{AudioFile, FileType};
use lofty::ogg::{OggPictureStorage, VorbisComments};
use lofty::picture::{Picture, PictureInformation};
use lofty::prelude::*;
use lofty::probe::Probe;
use lofty::tag::{ItemKey, ItemValue, Tag, TagType};

use crate::commands::safe_save::WorkingCopy;

/// A file's comments as stored, with the pictures the generic tag was given.
pub(crate) type StoredComments = (VorbisComments, Vec<(Picture, PictureInformation)>);

/// Saves `tag` — a Vorbis comment tag parsed from `work` and then edited —
/// back into `work`.
pub(crate) fn save(tag: &Tag, work: &mut WorkingCopy) -> Result<(), String> {
    let Some((comments, pictures)) = read_comments(work)? else {
        // Not a container this module reads: lofty's own save, as before.
        work.rewind_to_start()?;
        return tag.save_to(work, WriteOptions::default()).map_err(|e| e.to_string());
    };
    let patched = patch(&comments, &pictures, tag);
    work.rewind_to_start()?;
    patched.save_to(work, WriteOptions::default()).map_err(|e| e.to_string())
}

/// The comments `reader` holds — names, order and vendor string intact — and
/// every picture the generic tag gets from it, in the generic tag's order
/// (lofty lists a FLAC's picture blocks after any kept in its comment block).
/// `None` for a file that isn't FLAC, Ogg Vorbis, Opus or Speex.
///
/// The type comes from the content, as it does for lofty's writer.
pub(crate) fn read_comments<R: Read + Seek>(reader: &mut R) -> Result<Option<StoredComments>, String> {
    reader.rewind().map_err(|e| e.to_string())?;
    let file_type = Probe::new(&mut *reader)
        .guess_file_type()
        .map_err(|e| e.to_string())?
        .file_type();
    reader.rewind().map_err(|e| e.to_string())?;
    let options = ParseOptions::new().read_properties(false);
    let err = |e: lofty::error::LoftyError| e.to_string();
    let comments = match file_type {
        Some(FileType::Flac) => {
            let flac = lofty::flac::FlacFile::read_from(reader, options).map_err(err)?;
            let comments = flac.vorbis_comments().cloned().unwrap_or_default();
            let mut pictures = comments.pictures().to_vec();
            pictures.extend_from_slice(flac.pictures());
            return Ok(Some((comments, pictures)));
        }
        Some(FileType::Vorbis) => {
            lofty::ogg::VorbisFile::read_from(reader, options).map_err(err)?.vorbis_comments().clone()
        }
        Some(FileType::Opus) => {
            lofty::ogg::OpusFile::read_from(reader, options).map_err(err)?.vorbis_comments().clone()
        }
        Some(FileType::Speex) => {
            lofty::ogg::SpeexFile::read_from(reader, options).map_err(err)?.vorbis_comments().clone()
        }
        _ => return Ok(None),
    };
    let pictures = comments.pictures().to_vec();
    Ok(Some((comments, pictures)))
}

/// What becomes of one of the file's comments.
enum Slot {
    /// Written as `(name, value)`.
    Keep(String, String),
    /// Removed or changed by the edit. A new value of the same field takes its
    /// place, under its name.
    Vacant(ItemKey, String),
}

/// Whether two keys name the same field. Vorbis comment names are
/// case-insensitive; `ItemKey::Unknown`'s comparison is not.
fn same_field(a: &ItemKey, b: &ItemKey) -> bool {
    match (a, b) {
        (ItemKey::Unknown(a), ItemKey::Unknown(b)) => a.eq_ignore_ascii_case(b),
        _ => a == b,
    }
}

/// The comments to write: the file's (`original`, with the `pictures` read
/// alongside) with the changes `edited` — the generic view of them, edited —
/// applied.
pub(crate) fn patch(
    original: &VorbisComments,
    pictures: &[(Picture, PictureInformation)],
    edited: &Tag,
) -> VorbisComments {
    let field = |name: &str| ItemKey::from_key(TagType::VorbisComments, name);

    // lofty hands the generic tag the vendor string as an `EncoderSoftware`
    // item when the file has no ENCODER comment to show there. That item is the
    // vendor, not a comment: writing it out as one is how every edited file
    // gained an ENCODER field.
    let has_encoder = original.items().any(|(name, _)| field(name) == ItemKey::EncoderSoftware);
    let mut vendor = has_encoder.then(|| original.vendor().to_string());
    let mut wanted: Vec<Option<(&ItemKey, &str)>> = Vec::new();
    for item in edited.items() {
        // Vorbis comments are text only; lofty's writer skips binary items too.
        let (ItemValue::Text(value) | ItemValue::Locator(value)) = item.value() else {
            continue;
        };
        if vendor.is_none() && *item.key() == ItemKey::EncoderSoftware {
            vendor = Some(value.clone());
        } else {
            wanted.push(Some((item.key(), value.as_str())));
        }
    }

    // A comment the edit left alone stays as stored, where it was.
    let mut slots: Vec<Slot> = original
        .items()
        .map(|(name, value)| {
            let key = field(name);
            let unchanged = wanted
                .iter_mut()
                .find(|w| matches!(w, Some((k, v)) if same_field(k, &key) && *v == value));
            match unchanged {
                Some(w) => {
                    *w = None;
                    Slot::Keep(name.to_string(), value.to_string())
                }
                None => Slot::Vacant(key, name.to_string()),
            }
        })
        .collect();

    // New values fill the place of a vacated comment of the same field, under
    // its name; the rest go at the end under lofty's name for the field.
    for (key, value) in wanted.into_iter().flatten() {
        let vacated = slots
            .iter_mut()
            .find(|s| matches!(s, Slot::Vacant(k, _) if same_field(k, key)));
        if let Some(slot) = vacated {
            if let Slot::Vacant(_, name) = slot {
                *slot = Slot::Keep(std::mem::take(name), value.to_string());
            }
        } else if let Some(name) = key.map_key(TagType::VorbisComments, true) {
            slots.push(Slot::Keep(name.to_string(), value.to_string()));
        }
    }

    let mut out = VorbisComments::default();
    out.set_vendor(vendor.unwrap_or_default());
    for slot in slots {
        if let Slot::Keep(name, value) = slot {
            out.push(name, value);
        }
    }

    // An untouched picture keeps the size and colour details stored with it.
    let mut unused: Vec<Option<&(Picture, PictureInformation)>> = pictures.iter().map(Some).collect();
    for picture in edited.pictures() {
        let info = unused
            .iter_mut()
            .find(|u| matches!(u, Some((p, _)) if p == picture))
            .and_then(Option::take)
            .map_or_else(|| PictureInformation::from_picture(picture).unwrap_or_default(), |(_, info)| *info);
        // With the info supplied this can't fail.
        let _ = out.insert_picture(picture.clone(), Some(info));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn comments(vendor: &str, items: &[(&str, &str)]) -> VorbisComments {
        let mut c = VorbisComments::default();
        c.set_vendor(vendor.to_string());
        for (k, v) in items {
            c.push(k.to_string(), v.to_string());
        }
        c
    }

    fn items(c: &VorbisComments) -> Vec<(&str, &str)> {
        c.items().collect()
    }

    /// The generic tag the app edits, as lofty parses it from `c`.
    fn generic(c: &VorbisComments) -> Tag {
        Tag::from(c.clone())
    }

    const DJ_FILE: &[(&str, &str)] = &[
        ("TITLE", "Kerala"),
        ("MIXARTIST", "Bonobo"),
        ("ORGANIZATION", "Ninja Tune"),
        ("LABEL", "Ninja Tune"),
        ("KEY", "8A"),
        ("TOTALTRACKS", "12"),
        ("TRAKTOR4", "AAAA"),
    ];

    #[test]
    fn an_edit_leaves_every_other_comment_name_and_the_vendor_as_stored() {
        let original = comments("reference libFLAC 1.4.3 20230623", DJ_FILE);
        let mut tag = generic(&original);
        tag.insert_text(ItemKey::TrackTitle, "Kerala (Edit)".into());

        let out = patch(&original, &[], &tag);
        let mut expected = DJ_FILE.to_vec();
        expected[0].1 = "Kerala (Edit)";
        assert_eq!(items(&out), expected, "a comment was renamed, moved, doubled or dropped");
        assert_eq!(out.vendor(), "reference libFLAC 1.4.3 20230623");
    }

    #[test]
    fn a_changed_value_keeps_the_name_it_was_stored_under() {
        let original = comments("v", DJ_FILE);
        let mut tag = generic(&original);
        tag.insert_text(ItemKey::InitialKey, "9A".into());
        tag.insert_text(ItemKey::Remixer, "Four Tet".into());

        let out = patch(&original, &[], &tag);
        assert_eq!(out.get("KEY"), Some("9A"));
        assert_eq!(out.get("MIXARTIST"), Some("Four Tet"));
        assert_eq!(out.get("INITIALKEY"), None, "KEY was renamed");
        assert_eq!(out.get("REMIXER"), None, "MIXARTIST was renamed");
        assert_eq!(items(&out)[1], ("MIXARTIST", "Four Tet"), "the new value moved");
    }

    #[test]
    fn new_fields_get_lofty_names_and_removed_ones_go() {
        let original = comments("v", DJ_FILE);
        let mut tag = generic(&original);
        tag.remove_key(&ItemKey::Remixer);
        tag.insert_text(ItemKey::Bpm, "128".into());

        let out = patch(&original, &[], &tag);
        assert_eq!(out.get("MIXARTIST"), None);
        assert_eq!(items(&out).last(), Some(&("BPM", "128")));
        assert_eq!(items(&out).len(), DJ_FILE.len());
    }

    #[test]
    fn a_files_own_encoder_comment_and_its_vendor_both_stay() {
        let original = comments("reference libFLAC 1.3.2", &[("TITLE", "a"), ("ENCODER", "FFmpeg")]);
        let mut tag = generic(&original);
        tag.insert_text(ItemKey::TrackTitle, "b".into());

        let out = patch(&original, &[], &tag);
        assert_eq!(out.vendor(), "reference libFLAC 1.3.2");
        assert_eq!(items(&out), vec![("TITLE", "b"), ("ENCODER", "FFmpeg")]);
    }

    #[test]
    fn an_unedited_tag_writes_back_exactly_what_was_read() {
        let original = comments("v", &[("artist", "lower-case name"), ("GENRE", "House"), ("GENRE", "House")]);
        let out = patch(&original, &[], &generic(&original));
        assert_eq!(items(&out), items(&original));
        assert_eq!(out.vendor(), "v");
    }
}

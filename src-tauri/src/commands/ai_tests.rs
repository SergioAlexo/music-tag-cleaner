//! Round-trip tests for manual mode: whatever an outside chat AI pastes back
//! has to survive the same parsers the Ollama path uses.

use super::ai::*;
use crate::models::TrackInput;

fn track(index: u32, artist: &str, title: &str) -> TrackInput {
    TrackInput {
        index,
        filename: format!("{artist} - {title}.mp3"),
        artist: artist.into(),
        title: title.into(),
        year: String::new(),
        genre: String::new(),
        album: String::new(),
    }
}

#[test]
fn clean_prompt_carries_the_rules_and_the_track_list() {
    let prompt = ai_clean_prompt(vec![track(1, "Bad Bunny", "Tití Me Preguntó")], vec![], None).unwrap();
    assert!(prompt.contains("music metadata cleanup expert"));
    assert!(prompt.contains("Track list to clean:"));
    assert!(prompt.contains("Tití Me Preguntó"));
    // Scripts not opted into stay as written.
    assert!(prompt.contains("Cyrillic: keep it exactly as written"));
}

#[test]
fn clean_prompt_honours_transliteration_choices() {
    let prompt =
        ai_clean_prompt(vec![track(1, "Кино", "Группа крови")], vec!["Cyrillic".into()], None).unwrap();
    assert!(prompt.contains("Cyrillic: transliterate it phonetically"));
    assert!(prompt.contains("Hebrew: keep it exactly as written"));
}

#[test]
fn parses_a_bare_json_array() {
    let out = ai_parse_clean_response(
        r#"[{"index":1,"artist":"Bad Bunny","title":"Tití Me Preguntó","year":"2022","genre":"Reggaeton"}]"#
            .into(),
    )
    .unwrap();
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].index, 1);
    assert_eq!(out[0].artist.as_deref(), Some("Bad Bunny"));
}

#[test]
fn parses_an_answer_wrapped_in_prose_and_code_fences() {
    // What a chat UI typically hands back when the user copies the whole reply.
    let pasted = "Sure! Here are the cleaned tracks:\n\n```json\n[\n  \
{\"index\": 1, \"artist\": \"Daft Punk\", \"title\": \"One More Time\", \
\"year\": \"2000\", \"genre\": \"House\"},\n  \
{\"index\": 2, \"artist\": \"Justice\", \"title\": \"D.A.N.C.E.\", \
\"year\": \"2007\", \"genre\": \"Electronic\"}\n]\n```\n\nLet me know if you want more.";
    let out = ai_parse_clean_response(pasted.into()).unwrap();
    assert_eq!(out.len(), 2);
    assert_eq!(out[1].title.as_deref(), Some("D.A.N.C.E."));
    assert_eq!(out[1].year.as_deref(), Some("2007"));
}

#[test]
fn parses_an_answer_after_a_reasoning_block() {
    let pasted = "<think>The user wants clean tags.</think>\n[{\"index\":7,\"artist\":\"Kraftwerk\",\
\"title\":\"Autobahn\",\"year\":\"1974\",\"genre\":\"Electronic\"}]";
    let out = ai_parse_clean_response(pasted.into()).unwrap();
    assert_eq!(out[0].index, 7);
    assert_eq!(out[0].artist.as_deref(), Some("Kraftwerk"));
}

#[test]
fn keeps_global_indexes_so_batches_land_on_the_right_track() {
    let out = ai_parse_clean_response(
        r#"[{"index":"51","artist":"A","title":"B","year":"1999","genre":"Pop"}]"#.into(),
    )
    .unwrap();
    assert_eq!(out[0].index, 51);
}

#[test]
fn rejects_an_answer_with_no_json_in_it() {
    let err = ai_parse_clean_response("I'm sorry, I can't help with that.".into()).unwrap_err();
    assert!(err.contains("Could not parse"));
}

#[test]
fn a_year_only_prompt_asks_for_nothing_else() {
    let prompt =
        ai_clean_prompt(vec![track(1, "Daft Punk", "One More Time")], vec![], Some(vec!["year".into()])).unwrap();
    assert!(prompt.contains("YEAR: Return the ORIGINAL release year"));
    assert!(prompt.contains("Return ONLY these fields: YEAR."));
    assert!(prompt.contains("\"year\": \"YYYY\""));
    // No rules or output slots for the fields that were not requested.
    assert!(!prompt.contains("ARTIST: Keep only"));
    assert!(!prompt.contains("TITLE: Keep only"));
    assert!(!prompt.contains("\"genre\": \"Genre\""));
    assert!(!prompt.contains("SCRIPTS:"));
    // The track itself is still there to identify the song by.
    assert!(prompt.contains("One More Time"));
}

#[test]
fn no_or_unknown_fields_fall_back_to_the_default_four() {
    let default = ai_clean_prompt(vec![track(1, "A", "B")], vec![], None).unwrap();
    let junk = ai_clean_prompt(vec![track(1, "A", "B")], vec![], Some(vec!["albumArtist".into()])).unwrap();
    assert_eq!(default, junk);
    assert!(default.contains("Return ONLY these fields: ARTIST, TITLE, YEAR, GENRE."));
    assert!(!default.contains("ALBUM: Return"));
}

#[test]
fn album_is_returned_only_when_asked_for() {
    let prompt =
        ai_clean_prompt(vec![track(1, "A", "B")], vec![], Some(vec!["album".into(), "year".into()])).unwrap();
    assert!(prompt.contains("ALBUM: Return"));
    assert!(prompt.contains("Return ONLY these fields: YEAR, ALBUM."));
    let out = ai_parse_clean_response(r#"[{"index":1,"year":"2001","album":"Discovery"}]"#.into()).unwrap();
    assert_eq!(out[0].album.as_deref(), Some("Discovery"));
    assert_eq!(out[0].artist, None);
}

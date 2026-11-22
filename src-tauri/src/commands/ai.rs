use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::models::{AiUsage, CleanedTrack, OllamaStatus, TrackInput};

/// Emits token-usage counters from an Ollama `/api/generate` response so the
/// frontend can accumulate session/lifetime usage stats independent of the
/// command's own return value.
fn emit_usage(app: &AppHandle, model: &str, v: &Value, tracks: usize) {
    let _ = app.emit(
        "ai-usage",
        AiUsage {
            model: model.to_string(),
            prompt_eval_count: v["prompt_eval_count"].as_u64().unwrap_or(0),
            eval_count: v["eval_count"].as_u64().unwrap_or(0),
            tracks,
        },
    );
}

/// Non-Latin writing systems the user can opt into transliterating. Names
/// must match what the frontend's TRANSLITERATE_SCRIPTS list sends.
const SCRIPTS: &[&str] = &["Cyrillic", "Hebrew", "Arabic", "Greek", "Chinese/Japanese/Korean"];

fn script_rules(transliterate: &[String]) -> String {
    SCRIPTS
        .iter()
        .map(|name| {
            let wants_transliteration = transliterate.iter().any(|s| s.eq_ignore_ascii_case(name));
            let instruction = if wants_transliteration {
                "transliterate it phonetically into Latin letters (romanize how it sounds — do not translate the meaning)"
            } else {
                "keep it exactly as written — do not transliterate or translate it"
            };
            format!("   - {name}: {instruction}")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Fields AI Clean can be asked to return, in prompt order. "album" is opt-in;
/// the first four are the long-standing default. Must match `AI_CLEAN_FIELDS`
/// in `src/types.ts` (which also has "albumArtist", a local copy rule the
/// model never sees).
pub(crate) const CLEAN_FIELDS: &[&str] = &["artist", "title", "year", "genre", "album"];
const DEFAULT_CLEAN_FIELDS: &[&str] = &["artist", "title", "year", "genre"];

/// The requested fields in canonical order. Nothing recognisable (an older
/// caller that sends no list, or only "albumArtist") means the default four,
/// so a prompt is never built that asks the model for no fields at all.
pub(crate) fn clean_fields(requested: Option<&[String]>) -> Vec<&'static str> {
    let picked: Vec<&'static str> = match requested {
        Some(list) => CLEAN_FIELDS
            .iter()
            .copied()
            .filter(|f| list.iter().any(|r| r.eq_ignore_ascii_case(f)))
            .collect(),
        None => Vec::new(),
    };
    if picked.is_empty() {
        DEFAULT_CLEAN_FIELDS.to_vec()
    } else {
        picked
    }
}

const ARTIST_RULE: &str = r#"ARTIST: Keep only the main/lead artist. Remove all of the following from the artist field:
   - Legal full names (e.g. "Benito Antonio Martinez Ocasio" → remove, keep "Bad Bunny")
   - Co-writers, producers, publishers
   - Featured artists (ft., feat., &, x, N, -)
   - Duplicate names or alternative spellings of the same artist
   - Record label names
   - YouTube channel names (if the artist field looks like a channel, decode the real artist from the title)"#;

const TITLE_RULE: &str = r#"TITLE: Keep only the clean song name. Strip ALL of the following suffixes/additions:
   - (Radio Edit), (Club Mix), (Extended Mix), (Original Mix), (Album Version)
   - (feat. X), (ft. X), (with X), (Feat X), -Feat-
   - (Remastered YYYY), (Remastered), [Remastered]
   - (Live), (Live at X), (Acoustic), (Acoustic Version)
   - (Official Video), (Official Audio), (Music Video), (Lyric Video)
   - (Explicit), [Explicit], (Clean), (Dirty)
   - (Remix), (X Remix), -X Remix-, [X Remix]
   - (Slowed), (Sped Up), (Pitched), (Nightcore)
   - Any version tags in any language
   - YouTube video titles embedded in the tag — extract just the song name"#;

// The owner is a DJ: the year tells them how old the *song* is (will an older
// crowd know it?), not when this particular remix or cover came out. The old
// wording ("original release year") was read as "this release's year", so a
// new remix of an 80s song came back as the remix's year.
//
// Empty years: "if not certain, leave the existing year unchanged" made the
// model return "" for any song it wasn't sure of, so empty years stayed
// empty (9 of 20 of the owner's real empty-year tracks on Sonnet/low).
// For an empty year a best estimate is asked for instead (17 of 20); the
// person still reviews every change in the preview.
const YEAR_RULE: &str = r#"YEAR: Return the year the ORIGINAL SONG was first released — the song itself, not this particular version of it. The year must tell a DJ how old the song is.
   - Remixes, edits, extended/club/radio mixes, bootlegs, VIP mixes, remasters, re-releases, compilations, streaming uploads: return the year the original song came out, NOT the year of the remix or re-release.
   - Covers, re-sings and re-recordings by another artist, and new tracks built around an older song's recognizable melody, chorus or lyrics (interpolations): return the year the ORIGINAL song came out. Example: David Guetta "Forever Young" is built on Alphaville's "Forever Young" → 1984.
   - Mashups of several songs: return the year of the OLDEST song in the mashup.
   - A brand-new song that only borrows a short sample is its own song: return its own year.
   Use your music knowledge. If the existing year is filled in and you are not certain which song it is based on or when that came out, leave it unchanged.
   If the existing year is EMPTY, give your best estimate whenever you can identify the song at all (a likely year beats no year); return "" only if you cannot tell which song it is."#;

const GENRE_RULE: &str = "GENRE: Normalize to a standard single genre. Use common terms like: Pop, Rock, Hip-Hop, R&B, Reggaeton, House, Techno, Trance, Electronic, Dance, Folk, Country, Jazz, Classical, Metal, Punk, Soul, Funk, Latin, Reggae, Indie, Alternative. Do not use subgenres unless they are very widely recognized.";

const ALBUM_RULE: &str = "ALBUM: Return the name of the original album, EP or single the song was first released on — not a compilation, DJ-pool pack, or \"Various Artists\" collection. Use your music knowledge. If the existing album is already right keep it; if you are not certain, return an empty string \"\".";

/// Builds the exact prompt sent to the model. `transliterate` lists the
/// scripts (from `SCRIPTS`) the user wants romanized instead of preserved;
/// `fields` (already through `clean_fields`) are the only ones the model is
/// asked to return — a "year only" run carries no artist/title rules, so the
/// model can't "helpfully" rewrite fields nobody asked about. Also used
/// verbatim by `ai_preview_prompt` so the Settings UI can show the user
/// precisely what will be sent, never a hand-written summary that could
/// drift out of sync.
fn build_system_prompt(transliterate: &[String], fields: &[&str]) -> String {
    let has = |f: &str| fields.contains(&f);
    let mut rules: Vec<String> = Vec::new();
    if has("artist") {
        rules.push(ARTIST_RULE.to_string());
    }
    if has("title") {
        rules.push(TITLE_RULE.to_string());
    }
    if has("year") {
        rules.push(YEAR_RULE.to_string());
    }
    if has("genre") {
        rules.push(GENRE_RULE.to_string());
    }
    if has("album") {
        rules.push(ALBUM_RULE.to_string());
    }
    let names_edited = has("artist") || has("title");
    let returned = fields.iter().map(|f| f.to_uppercase()).collect::<Vec<_>>().join(", ");
    // The track list always carries every field for identification, so say
    // plainly which ones are context only.
    rules.push(format!(
        "Return ONLY these fields: {returned}. Every other field in the track list (and the filename) is there to help you identify the song — do not return it and do not change it."
    ));
    if names_edited {
        rules.push(format!(
            "SCRIPTS: Apply this per writing system, to both Artist and Title:\n{}\n   Any other non-Latin script not listed above: keep it exactly as written.",
            script_rules(transliterate)
        ));
        rules.push("For mashups (two songs blended together), keep the mashup creator as the artist and format the title as: \"Song1 N Song2\"".to_string());
        rules.push("FILENAME FALLBACK: Every track includes a \"filename\" field. When the artist or title is empty, missing, or clearly junk, derive them from the filename — filenames are usually \"Artist - Title\" or \"Artist - Title (Mix)\". Apply all the cleaning rules above to values you take from the filename. If, after using both the metadata AND the filename, you still cannot determine the artist or the title, return an empty string \"\" for that field (do not guess a random value).".to_string());
    } else {
        rules.push("IDENTIFYING THE SONG: Use the artist and title, and when they are empty or clearly junk, the \"filename\" field — filenames are usually \"Artist - Title\" or \"Artist - Title (Mix)\". If you cannot tell which song a track is, return an empty string \"\" for every field of that track (do not guess).".to_string());
    }
    let numbered = rules
        .iter()
        .enumerate()
        .map(|(i, r)| format!("{}. {r}", i + 1))
        .collect::<Vec<_>>()
        .join("\n");

    let example = |f: &str| match f {
        "artist" => "\"artist\": \"cleaned artist\"",
        "title" => "\"title\": \"cleaned title\"",
        "year" => "\"year\": \"YYYY\"",
        "genre" => "\"genre\": \"Genre\"",
        _ => "\"album\": \"Album name\"",
    };
    let members = std::iter::once("\"index\": 1")
        .chain(fields.iter().map(|f| example(f)))
        .map(|m| format!("    {m}"))
        .collect::<Vec<_>>()
        .join(",\n");
    let intro = if names_edited {
        "You will receive a list of audio tracks with messy metadata and must return cleaned versions."
    } else {
        "You will receive a list of audio tracks and must return the requested metadata for each one."
    };
    format!(
        "You are a music metadata cleanup expert. {intro}\nRULES:\n{numbered}\nOUTPUT FORMAT: Return ONLY a valid JSON array, no explanation, no markdown, no preamble:\n[\n  {{\n{members}\n  }},\n  ...\n]"
    )
}

/// Returns the exact prompt `ai_clean_batch` would send for the given
/// transliteration choices and fields, without needing a track list — used by
/// the Settings UI's "What does AI Clean do?" viewer.
#[tauri::command]
pub fn ai_preview_prompt(transliterate_scripts: Vec<String>, fields: Option<Vec<String>>) -> String {
    build_system_prompt(&transliterate_scripts, &clean_fields(fields.as_deref()))
}

/// The complete prompt — the rules above plus the track list — that
/// `ai_clean_batch` posts to Ollama.
pub(crate) fn build_clean_prompt(
    tracks: &[TrackInput],
    transliterate: &[String],
    fields: Option<&[String]>,
) -> Result<String, String> {
    let track_list = serde_json::to_string_pretty(tracks).map_err(|e| e.to_string())?;
    let system_prompt = build_system_prompt(transliterate, &clean_fields(fields));
    Ok(format!("{system_prompt}\n\nTrack list to clean:\n{track_list}"))
}

/// Manual mode: hands the frontend the very same prompt `ai_clean_batch`
/// would send, so the user can paste it into any AI they like and bring the
/// answer back. Sharing one builder is the point — a hand-written copy of
/// the rules would drift out of sync with the automated path.
#[tauri::command]
pub fn ai_clean_prompt(
    tracks: Vec<TrackInput>,
    transliterate_scripts: Vec<String>,
    fields: Option<Vec<String>>,
) -> Result<String, String> {
    build_clean_prompt(&tracks, &transliterate_scripts, fields.as_deref())
}

/// Manual mode: parses a response the user pasted back from an outside AI
/// with the same tolerant parser the Ollama path uses, so markdown fences,
/// reasoning blocks and `{"tracks": [...]}` wrappers are all accepted.
#[tauri::command]
pub fn ai_parse_clean_response(text: String) -> Result<Vec<CleanedTrack>, String> {
    parse_cleaned(&text)
}

#[tauri::command]
pub async fn check_ollama(url: String) -> OllamaStatus {
    let client = match reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return OllamaStatus {
                running: false,
                models: vec![],
                error: Some(e.to_string()),
            }
        }
    };
    let endpoint = format!("{}/api/tags", url.trim_end_matches('/'));
    match client.get(&endpoint).send().await {
        Ok(resp) if resp.status().is_success() => match resp.json::<Value>().await {
            Ok(v) => {
                let models = v["models"]
                    .as_array()
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|m| m["name"].as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default();
                OllamaStatus {
                    running: true,
                    models,
                    error: None,
                }
            }
            Err(e) => OllamaStatus {
                running: false,
                models: vec![],
                error: Some(format!("Unexpected response from Ollama: {e}")),
            },
        },
        Ok(resp) => OllamaStatus {
            running: false,
            models: vec![],
            error: Some(format!("Ollama returned HTTP {}", resp.status())),
        },
        Err(e) => OllamaStatus {
            running: false,
            models: vec![],
            error: Some(e.to_string()),
        },
    }
}

#[tauri::command]
pub async fn ai_clean_batch(
    app: AppHandle,
    url: String,
    model: String,
    tracks: Vec<TrackInput>,
    transliterate_scripts: Vec<String>,
    fields: Option<Vec<String>>,
) -> Result<Vec<CleanedTrack>, String> {
    let track_count = tracks.len();
    let prompt = build_clean_prompt(&tracks, &transliterate_scripts, fields.as_deref())?;
    let body = json!({
        "model": model,
        "prompt": prompt,
        "stream": false,
        "format": "json"
    });

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        // Local models can take a long time on big batches.
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .post(format!("{}/api/generate", url.trim_end_matches('/')))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Could not reach Ollama: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("Ollama returned HTTP {}", resp.status()));
    }

    let v: Value = resp
        .json()
        .await
        .map_err(|e| format!("Invalid response from Ollama: {e}"))?;
    emit_usage(&app, &model, &v, track_count);
    let text = v["response"]
        .as_str()
        .ok_or_else(|| "Ollama response is missing the 'response' field".to_string())?;
    parse_cleaned(text)
}

/// Generic text generation through Ollama (D2 "New button"): one prompt in,
/// the model's reply out, no JSON mode and no track parsing. Kept next to
/// `ai_clean_batch` so the backend choice stays in one place.
#[tauri::command]
pub async fn ai_generate_text(url: String, model: String, prompt: String) -> Result<String, String> {
    let body = json!({ "model": model, "prompt": prompt, "stream": false });
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(format!("{}/api/generate", url.trim_end_matches('/')))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Could not reach Ollama: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Ollama returned HTTP {}", resp.status()));
    }
    let v: Value = resp.json().await.map_err(|e| format!("Invalid response from Ollama: {e}"))?;
    let text = v["response"]
        .as_str()
        .ok_or_else(|| "Ollama response is missing the 'response' field".to_string())?;
    Ok(strip_reasoning(text).trim().to_string())
}

pub(crate) fn parse_cleaned(text: &str) -> Result<Vec<CleanedTrack>, String> {
    let text = strip_reasoning(text);
    if let Ok(v) = serde_json::from_str::<Value>(text.trim()) {
        if let Some(tracks) = tracks_from_value(&v) {
            return Ok(tracks);
        }
    }
    // Some models wrap the JSON in prose or markdown fences despite
    // instructions — fall back to the outermost [...] slice.
    if let Some(slice) = extract_json_array(text) {
        if let Ok(v) = serde_json::from_str::<Value>(slice) {
            if let Some(tracks) = tracks_from_value(&v) {
                return Ok(tracks);
            }
        }
    }
    let preview: String = text.chars().take(300).collect();
    Err(format!("Could not parse the AI response as JSON: {preview}"))
}

/// Reasoning models (deepseek-r1 etc.) may emit a <think> block first.
fn strip_reasoning(text: &str) -> &str {
    match text.rfind("</think>") {
        Some(pos) => &text[pos + "</think>".len()..],
        None => text,
    }
}

fn extract_json_array(text: &str) -> Option<&str> {
    let start = text.find('[')?;
    let end = text.rfind(']')?;
    (end > start).then(|| &text[start..=end])
}

fn tracks_from_value(v: &Value) -> Option<Vec<CleanedTrack>> {
    let arr = match v {
        Value::Array(a) => a,
        // format:"json" sometimes yields {"tracks": [...]} — take the
        // first array-valued member.
        Value::Object(o) => o.values().find_map(|x| x.as_array())?,
        _ => return None,
    };
    let tracks: Vec<CleanedTrack> = arr.iter().filter_map(track_from_value).collect();
    if tracks.is_empty() {
        None
    } else {
        Some(tracks)
    }
}

fn track_from_value(v: &Value) -> Option<CleanedTrack> {
    let index = v
        .get("index")
        .and_then(|i| i.as_u64().or_else(|| i.as_str().and_then(|s| s.parse().ok())))?;
    let text = |key: &str| -> Option<String> {
        let field = v.get(key)?;
        let s = field
            .as_str()
            .map(str::to_string)
            .or_else(|| field.as_u64().map(|n| n.to_string()))?;
        let s = s.trim().to_string();
        (!s.is_empty()).then_some(s)
    };
    Some(CleanedTrack {
        index: index as u32,
        artist: text("artist"),
        title: text("title"),
        year: text("year"),
        genre: text("genre"),
        album: text("album"),
    })
}


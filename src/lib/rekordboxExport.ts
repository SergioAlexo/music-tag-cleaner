import type { AudioFile, TagData } from "../types";
import { basename } from "../types";

/** Builds an `.m3u8` playlist body (UTF-8, `\n`-separated, absolute paths)
 * that Rekordbox, Serato, Traktor and every other DJ tool can import
 * directly. `#EXTINF` duration is rounded to whole seconds, or `-1` (the
 * standard "unknown" sentinel) when the file's duration wasn't loaded. */
export function buildM3u8(paths: string[], files: Record<string, AudioFile>, tags: Record<string, TagData>): string {
  const lines = ["#EXTM3U"];
  for (const p of paths) {
    const t = tags[p];
    const f = files[p];
    const artist = t?.artist?.trim();
    const title = t?.title?.trim() || f?.filename || basename(p);
    const duration = f?.durationSecs ? Math.round(f.durationSecs) : -1;
    const label = artist ? `${artist} - ${title}` : title;
    lines.push(`#EXTINF:${duration},${label}`);
    lines.push(p);
  }
  return lines.join("\n") + "\n";
}

/**
 * Escapes text for a double-quoted XML attribute. Tab/newline/CR become
 * character references (a parser would otherwise normalise them to spaces),
 * and the other C0 control characters are dropped: XML 1.0 forbids them
 * outright, so a single stray \x01 in a messy tag — exactly the kind of tag
 * this app exists to clean — made Rekordbox reject the whole file.
 */
export function escapeXmlAttr(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\t/g, "&#9;")
    .replace(/\n/g, "&#10;")
    .replace(/\r/g, "&#13;");
}

/**
 * Percent-encodes a Windows path into the `file://localhost/…` form
 * Rekordbox itself writes — the exact inverse of `location_to_path()` in
 * `rekordbox_import.rs` (backslashes to forward slashes, each segment
 * percent-encoded except the drive letter).
 */
export function pathToLocation(path: string): string {
  // A macOS path's leading "/" is the separator after "localhost", not an
  // empty first segment — keeping it produced "file://localhost//Users/…".
  const forward = path.replace(/\\/g, "/").replace(/^\/+/, "");
  return forward
    .split("/")
    .map((seg, i) => (i === 0 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg)))
    .join("/")
    .replace(/^/, "file://localhost/");
}

const KIND_LABELS: Record<string, string> = {
  mp3: "MP3 File",
  flac: "FLAC File",
  wav: "WAV File",
  aiff: "AIFF File",
  aif: "AIFF File",
  m4a: "M4A File",
  aac: "AAC File",
  ogg: "OGG File",
};

/**
 * Builds a `rekordbox.xml`-style document (a `<COLLECTION>` of the given
 * tracks plus one `<PLAYLISTS>` node listing them) that Rekordbox's "Import
 * Playlist" can read, following the same TRACK-attribute / NODE-Type schema
 * `rekordbox_import.rs` reads on the way in. `TrackID`s are assigned
 * sequentially — Rekordbox re-keys them against its own collection on
 * import, they only need to be unique and consistent within this file.
 *
 * Unlike the read side (F5), this hasn't been round-tripped through a real
 * Rekordbox import — there's no Rekordbox install to test against here. The
 * schema matches the documented format and what `rekordbox_import.rs`
 * already parses back out correctly, but treat a first import as unverified
 * until it's been tried once.
 */
export function buildRekordboxPlaylistXml(
  playlistName: string,
  paths: string[],
  files: Record<string, AudioFile>,
  tags: Record<string, TagData>,
): string {
  const tracks = paths.map((p, i) => {
    const id = i + 1;
    const t = tags[p];
    const f = files[p];
    const name = t?.title?.trim() || f?.filename || basename(p);
    const kind = f ? (KIND_LABELS[f.format.toLowerCase()] ?? `${f.format.toUpperCase()} File`) : "";
    const totalTime = f?.durationSecs ? Math.round(f.durationSecs) : 0;
    const attrs = [
      `TrackID="${id}"`,
      `Name="${escapeXmlAttr(name)}"`,
      t?.artist?.trim() ? `Artist="${escapeXmlAttr(t.artist.trim())}"` : "",
      t?.album?.trim() ? `Album="${escapeXmlAttr(t.album.trim())}"` : "",
      kind ? `Kind="${escapeXmlAttr(kind)}"` : "",
      f ? `Size="${f.size}"` : "",
      totalTime ? `TotalTime="${totalTime}"` : "",
      `Location="${escapeXmlAttr(pathToLocation(p))}"`,
    ]
      .filter(Boolean)
      .join(" ");
    return { id, attrs };
  });

  const collection = tracks.map((t) => `    <TRACK ${t.attrs}/>`).join("\n");
  const playlistTracks = tracks.map((t) => `        <TRACK Key="${t.id}"/>`).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <PRODUCT Name="Vatra Wave" Version="1.0" Company=""/>
  <COLLECTION Entries="${tracks.length}">
${collection}
  </COLLECTION>
  <PLAYLISTS>
    <NODE Type="0" Name="ROOT" Count="1">
      <NODE Name="${escapeXmlAttr(playlistName)}" Type="1" KeyType="0" Entries="${tracks.length}">
${playlistTracks}
      </NODE>
    </NODE>
  </PLAYLISTS>
</DJ_PLAYLISTS>
`;
}

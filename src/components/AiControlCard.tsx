import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Copy } from "lucide-react";

import type { Settings } from "../types";
import { Button, Card, CardHeader, Row } from "./ui";
import { setAllowWithoutAsking, useAllowWithoutAsking } from "../hooks/useActionBridge";

interface BridgeStatus {
  running: boolean;
  port: number | null;
  bridgeJsonPath: string;
  mcpExe: string;
  mcpExeExists: boolean;
}

type Notify = (message: string, kind?: "success" | "error" | "info") => void;

/**
 * Settings -> "AI control" (D1). The bridge itself is started/stopped by an
 * effect in App (so it follows the setting even with this page closed); this
 * card is the switch plus the copy-paste install snippets.
 */
export function AiControlCard({
  settings,
  onUpdate,
  notify,
}: {
  settings: Settings;
  onUpdate: (fn: (prev: Settings) => Settings) => void;
  notify: Notify;
}) {
  const [status, setStatus] = useState<BridgeStatus | null>(null);
  const allow = useAllowWithoutAsking();

  const refresh = useCallback(
    () => invoke<BridgeStatus>("bridge_status").then(setStatus).catch(() => setStatus(null)),
    [],
  );
  useEffect(() => {
    // The App effect flips the server on/off right after the setting changes.
    const t = setTimeout(() => void refresh(), 400);
    return () => clearTimeout(t);
  }, [settings.aiControl, refresh]);

  const exe = status?.mcpExe ?? "mtc-mcp.exe";
  const cliSnippet = `claude mcp add music-tag-cleaner -- "${exe}"`;
  const desktopSnippet = JSON.stringify(
    { mcpServers: { "music-tag-cleaner": { command: exe, args: [] } } },
    null,
    2,
  );
  const copy = (text: string, what: string) =>
    navigator.clipboard.writeText(text).then(
      () => notify(`Copied ${what}`, "success"),
      () => notify("Could not copy", "error"),
    );

  return (
    <Card>
      <CardHeader
        title="AI control"
        hint="Let an AI assistant (Claude Code, Claude desktop, ...) read and drive this app over a local connection"
      />
      <div className="px-5 py-3">
        <Row
          label="Allow AI control"
          hint="Starts a server on 127.0.0.1 only, protected by a random key. Off by default; nothing is reachable from other computers."
        >
          <input
            type="checkbox"
            className="accent-[var(--primary)]"
            checked={settings.aiControl}
            onChange={(e) => onUpdate((p) => ({ ...p, aiControl: e.target.checked }))}
          />
        </Row>
        {settings.aiControl && (
          <>
            <Row
              label="Status"
              hint={
                status?.running
                  ? `Listening on 127.0.0.1:${status.port}. Connection file: ${status.bridgeJsonPath}`
                  : "Not running"
              }
            >
              <span className="text-xs text-muted-foreground">{status?.running ? "On" : "Starting..."}</span>
            </Row>
            <Row
              label="Run risky actions without asking (this session)"
              hint="Deleting, renaming, moving, converting. Otherwise each one asks here first. Resets when the app closes."
            >
              <input
                type="checkbox"
                className="accent-[var(--primary)]"
                checked={allow}
                onChange={(e) => setAllowWithoutAsking(e.target.checked)}
              />
            </Row>
            <div className="mt-3 space-y-2 text-xs">
              <p className="text-muted-foreground">
                Connect Claude Code (the helper program <code>mtc-mcp</code>
                {status && !status.mcpExeExists ? (
                  <>
                    {" "}
                    was not found next to the app at <code>{exe}</code>; build it with{" "}
                    <code>cargo build --release</code> in the <code>mcp</code> folder and copy it there
                  </>
                ) : null}
                ):
              </p>
              <div className="flex items-start gap-2">
                <pre className="min-w-0 flex-1 overflow-x-auto rounded-md border bg-muted/40 p-2">{cliSnippet}</pre>
                <Button variant="outline" size="sm" onClick={() => void copy(cliSnippet, "command")}>
                  <Copy />
                </Button>
              </div>
              <p className="text-muted-foreground">Or add this to claude_desktop_config.json:</p>
              <div className="flex items-start gap-2">
                <pre className="min-w-0 flex-1 overflow-x-auto rounded-md border bg-muted/40 p-2">{desktopSnippet}</pre>
                <Button variant="outline" size="sm" onClick={() => void copy(desktopSnippet, "config")}>
                  <Copy />
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

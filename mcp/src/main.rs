//! mtc-mcp: MCP server (stdio) for Music Tag Cleaner.
//!
//! Tools are generated from the app's action registry (`GET /actions`) every
//! time a client asks for the list, so actions added in the app later (new
//! releases, D2 plugin buttons) show up without touching this program.
//! stdout carries the protocol only; diagnostics go to stderr.

mod bridge;
mod tools;

use std::sync::{Arc, Mutex};

use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, ErrorData, ListResourcesResult,
    ListToolsResult, PaginatedRequestParams, ReadResourceRequestParams, ReadResourceResponse, ReadResourceResult, Resource,
    ResourceContents, Implementation, ServerCapabilities, ServerConfig, Tool,
};
use rmcp::service::{RequestContext, RoleServer};
use rmcp::{ServerHandler, ServiceExt};
use serde_json::{json, Value};

use bridge::{Bridge, BridgeError};
use tools::{build_tools, render, ToolSet, RESOURCES};

const STATUS_TOOL: &str = "mtc_connection_status";

struct Mtc {
    bridge: Arc<Bridge>,
    last: Arc<Mutex<Option<Arc<ToolSet>>>>,
}

impl Mtc {
    /// Fetches the live action list; falls back to the last good one if the app went away.
    async fn tool_set(&self) -> Result<Arc<ToolSet>, BridgeError> {
        let bridge = self.bridge.clone();
        match tokio::task::spawn_blocking(move || bridge.actions()).await {
            Ok(Ok(actions)) => {
                let set = Arc::new(build_tools(&actions));
                *self.last.lock().unwrap_or_else(|e| e.into_inner()) = Some(set.clone());
                Ok(set)
            }
            Ok(Err(e)) => self.last.lock().unwrap_or_else(|e| e.into_inner()).clone().ok_or(e),
            Err(e) => Err(BridgeError::Http(format!("internal error: {e}"))),
        }
    }

    async fn call(&self, action: String, params: Value) -> Result<Value, BridgeError> {
        let bridge = self.bridge.clone();
        tokio::task::spawn_blocking(move || bridge.call(&action, params))
            .await
            .map_err(|e| BridgeError::Http(format!("internal error: {e}")))?
    }
}

fn text_result(text: String, is_error: bool) -> CallToolResult {
    let content = vec![ContentBlock::text(text)];
    if is_error {
        CallToolResult::error(content)
    } else {
        CallToolResult::success(content)
    }
}

fn status_tool() -> Tool {
    serde_json::from_value(json!({
        "name": STATUS_TOOL,
        "description": "Checks the connection to Music Tag Cleaner and explains how to turn on AI control if it is off.",
        "inputSchema": {"type": "object", "properties": {}},
        "annotations": {"readOnlyHint": true}
    }))
    .expect("static tool json")
}

impl ServerHandler for Mtc {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().enable_resources().build())
            .with_server_info(Implementation::new("music-tag-cleaner", env!("CARGO_PKG_VERSION")))
            .with_instructions(
            "Controls the Music Tag Cleaner desktop app. Typical flow: session_list or library_search to find tracks, \
             table_select / tracks by path, then an action. Actions that change tags usually build a preview \
             (tags_standardize, tags_aiClean, ...): read it with changes_get, then write it with changes_apply or drop \
             it with changes_cancel. Risky actions ask the person for approval inside the app. Use script_run with \
             dryRun:true to check a multi-step plan first.",
        )
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let mut list: Vec<Tool> = vec![status_tool()];
        if let Ok(set) = self.tool_set().await {
            for t in &set.tools {
                match serde_json::from_value::<Tool>(t.clone()) {
                    Ok(t) => list.push(t),
                    Err(e) => eprintln!("mtc-mcp: skipping a tool that does not convert: {e}"),
                }
            }
        }
        Ok(ListToolsResult::with_all_items(list))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let name = request.name.to_string();
        if name == STATUS_TOOL {
            let out = match self.tool_set().await {
                Ok(set) => text_result(format!("Connected. {} actions available.", set.tools.len()), false),
                Err(e) => text_result(e.to_string(), true),
            };
            return Ok(out.into());
        }
        let set = match self.tool_set().await {
            Ok(s) => s,
            Err(e) => return Ok(text_result(e.to_string(), true).into()),
        };
        let Some(action) = set.by_name.get(&name).cloned() else {
            return Err(ErrorData::invalid_params(format!("Unknown tool \"{name}\""), None));
        };
        let params = Value::Object(request.arguments.unwrap_or_default());
        Ok(match self.call(action, params).await {
            Ok(v) => text_result(render(&v), false),
            Err(e) => text_result(e.to_string(), true),
        }
        .into())
    }

    async fn list_resources(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, ErrorData> {
        let items = RESOURCES
            .iter()
            .map(|(uri, _, desc)| {
                let mut r = Resource::new(*uri, uri.trim_start_matches("mtc://"));
                r.description = Some((*desc).to_string());
                r.mime_type = Some("application/json".into());
                r
            })
            .collect();
        Ok(ListResourcesResult::with_all_items(items))
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResponse, ErrorData> {
        let Some((_, action, _)) = RESOURCES.iter().find(|(u, _, _)| *u == request.uri) else {
            return Err(ErrorData::invalid_params(format!("Unknown resource {}", request.uri), None));
        };
        match self.call((*action).to_string(), json!({})).await {
            Ok(v) => Ok(ReadResourceResult::new(vec![ResourceContents::text(render(&v), request.uri)]).into()),
            Err(e) => Err(ErrorData::internal_error(e.to_string(), None)),
        }
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let server = Mtc {
        bridge: Arc::new(Bridge::new(bridge::bridge_file_path())),
        last: Arc::new(Mutex::new(None)),
    };
    let service = server.serve(rmcp::transport::stdio()).await?;
    service.waiting().await?;
    Ok(())
}

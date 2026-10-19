//! Turning the app's action list into MCP tool definitions (pure, tested).

use std::collections::HashMap;

use serde_json::{json, Value};

/// MCP clients (Claude included) only accept `[A-Za-z0-9_-]{1,64}` tool names.
pub fn tool_name(action_id: &str) -> String {
    let mut name: String = action_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    name.truncate(64);
    name
}

pub struct ToolSet {
    /// MCP-ready tool objects (`name`, `description`, `inputSchema`, `annotations`).
    pub tools: Vec<Value>,
    /// tool name -> action id
    pub by_name: HashMap<String, String>,
}

/// One tool per action. An action with an unusable shape is skipped, not fatal:
/// a bad plugin registration must not take every other tool down with it.
pub fn build_tools(actions: &[Value]) -> ToolSet {
    let mut tools = Vec::new();
    let mut by_name = HashMap::new();
    for a in actions {
        let Some(id) = a["id"].as_str() else { continue };
        let name = tool_name(id);
        if by_name.contains_key(&name) {
            continue;
        }
        let mut schema = a["params"].clone();
        if !schema.is_object() || schema["type"] != "object" {
            schema = json!({"type": "object", "properties": {}});
        }
        let dangerous = a["dangerous"].as_bool().unwrap_or(false);
        let read_only = a["readOnly"].as_bool().unwrap_or(false);
        let base = a["description"].as_str().or(a["title"].as_str()).unwrap_or(id);
        let description = if dangerous {
            format!("{base} [Risky: the person must approve this in the app.]")
        } else {
            base.to_string()
        };
        tools.push(json!({
            "name": name,
            "title": a["title"].as_str().unwrap_or(id),
            "description": description,
            "inputSchema": schema,
            "annotations": {
                "readOnlyHint": read_only,
                "destructiveHint": dangerous,
                "openWorldHint": false
            }
        }));
        by_name.insert(name, id.to_string());
    }
    ToolSet { tools, by_name }
}

/// Resources exposed besides tools: `uri -> (action id, description)`.
pub const RESOURCES: &[(&str, &str, &str)] = &[
    ("mtc://session", "session.list", "Tracks in the current Vatra Wave tab"),
    ("mtc://selection", "session.selection", "Tracks currently selected in the table"),
];

pub fn render(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        other => serde_json::to_string_pretty(other).unwrap_or_else(|_| other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Vec<Value> {
        vec![
            json!({"id": "session.list", "title": "List", "description": "Lists", "readOnly": true, "dangerous": false,
                   "params": {"type": "object", "properties": {"limit": {"type": "integer"}}}}),
            json!({"id": "files.delete", "title": "Delete", "description": "Recycles", "dangerous": true,
                   "params": {"type": "object", "properties": {}}}),
            json!({"id": "plugin.weird", "title": "Weird", "params": "not a schema"}),
            json!({"noid": true}),
        ]
    }

    #[test]
    fn names_are_client_safe() {
        assert_eq!(tool_name("session.list"), "session_list");
        assert_eq!(tool_name("a.b-c d"), "a_b-c_d");
        assert_eq!(tool_name(&"x".repeat(100)).len(), 64);
    }

    #[test]
    fn one_tool_per_action_with_schema_and_hints() {
        let set = build_tools(&sample());
        assert_eq!(set.tools.len(), 3, "the entry without an id is skipped");
        assert_eq!(set.by_name["session_list"], "session.list");
        let list = &set.tools[0];
        assert_eq!(list["inputSchema"]["properties"]["limit"]["type"], "integer");
        assert_eq!(list["annotations"]["readOnlyHint"], true);
        let del = &set.tools[1];
        assert_eq!(del["annotations"]["destructiveHint"], true);
        assert!(del["description"].as_str().unwrap().contains("approve"));
        // A malformed schema falls back to "no parameters" rather than breaking the list.
        assert_eq!(set.tools[2]["inputSchema"]["type"], "object");
    }

    #[test]
    fn name_collisions_keep_the_first() {
        let set = build_tools(&[json!({"id": "a.b", "params": {"type":"object"}}), json!({"id": "a_b", "params": {"type":"object"}})]);
        assert_eq!(set.tools.len(), 1);
        assert_eq!(set.by_name["a_b"], "a.b");
    }

    #[test]
    fn render_prints_strings_raw_and_json_pretty() {
        assert_eq!(render(&json!("hi")), "hi");
        assert!(render(&json!({"a": 1})).contains("\"a\": 1"));
    }
}

//! Server zones for the phone apps: every other paired server, listed in the
//! navigator of the one on screen with the projects it listed on its last
//! visit, so a person works in any number of teams from one list. The same
//! rules as Polyth Desktop (`apps/desktop/src/serverZones.ts`).
//!
//! Only the server on screen has a page, so nothing here opens a connection.
//! That page lists its own projects (`zones.report`); the last list per server
//! is kept in `zones.json` and handed to the page of whichever server is open.
//!
//! The native plugin names the sender (`connectionId`) from the origin of the
//! proxy it opened, never from what the page says. A page runs its server's
//! packages, so it reads the other servers only once the person allowed that
//! server (`zones.allow`, behind the app's own prompt), and a click goes only
//! to a zone it may see and a project that zone listed. Even then it gets a
//! server's name and a random key for it, never a connection id.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use polyth_link_core::LinkError;
use rand::RngCore;
use serde_json::{json, Map, Value};

use super::{display_label, metadata_path, read_metadata, write_metadata};

const MAX_PROJECTS: usize = 200;
const MAX_NAME_CHARS: usize = 120;
const MAX_ICON_BYTES: usize = 4096;
const MAX_ID_CHARS: usize = 128;

/// What the page of a sender may see: its own server, and the other servers as
/// `(connection id, zone)` once the person allowed that sender.
type VisibleZones = (Value, Option<Vec<(String, Value)>>);

/// One record per server: `{id, key?, allowed?, folded?, projects?, reportedAt?}`.
fn zones_path(data_dir: &Path) -> PathBuf {
    data_dir.join("zones.json")
}

/// A damaged file costs the snapshots and the choices, never the connections.
fn read_records(data_dir: &Path) -> Vec<Value> {
    read_metadata(&zones_path(data_dir)).unwrap_or_default()
}

fn record<'a>(records: &'a [Value], id: &str) -> Option<&'a Value> {
    records
        .iter()
        .find(|item| item.get("id").and_then(Value::as_str) == Some(id))
}

fn flag(records: &[Value], id: &str, key: &str) -> bool {
    record(records, id)
        .and_then(|item| item.get(key))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// A server's record, made when there is none yet.
fn slot<'a>(
    records: &'a mut Vec<Value>,
    id: &str,
) -> Result<&'a mut Map<String, Value>, LinkError> {
    let index = match records
        .iter()
        .position(|item| item.get("id").and_then(Value::as_str) == Some(id))
    {
        Some(index) => index,
        None => {
            records.push(json!({ "id": id }));
            records.len() - 1
        }
    };
    records[index]
        .as_object_mut()
        .ok_or(LinkError::PairingStorageFailed)
}

/// Changes one server's record and writes the file.
fn update(
    data_dir: &Path,
    id: &str,
    change: impl FnOnce(&mut Map<String, Value>),
) -> Result<(), LinkError> {
    let mut records = read_records(data_dir);
    change(slot(&mut records, id)?);
    write_metadata(&zones_path(data_dir), &records)
}

/// The records with a key for each of `servers`: the name a page uses for a
/// zone. Random, made on first sight and kept, so a server's page never holds
/// another server's connection id.
fn keyed_records(data_dir: &Path, servers: &[&Server]) -> Result<Vec<Value>, LinkError> {
    let mut records = read_records(data_dir);
    let mut changed = false;
    for server in servers {
        let object = slot(&mut records, &server.id)?;
        if object
            .get("key")
            .and_then(Value::as_str)
            .is_some_and(|key| !key.is_empty())
        {
            continue;
        }
        let mut bytes = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut bytes);
        object.insert("key".into(), hex::encode(bytes).into());
        changed = true;
    }
    if changed {
        write_metadata(&zones_path(data_dir), &records)?;
    }
    Ok(records)
}

fn project_id(value: &Value) -> Option<&str> {
    let id = value.as_str()?;
    let count = id.chars().count();
    ((1..=MAX_ID_CHARS).contains(&count)
        && !id
            .chars()
            .any(|ch| ch.is_whitespace() || ch.is_control() || "/\\?#%".contains(ch)))
    .then_some(id)
}

fn project_name(raw: &str) -> Option<String> {
    let joined = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let kept: String = joined.chars().take(MAX_NAME_CHARS).collect();
    let kept = kept.trim_end();
    (!kept.is_empty() && !kept.chars().any(char::is_control)).then(|| kept.to_string())
}

fn color(value: &str) -> bool {
    value.strip_prefix('#').is_some_and(|hex| {
        (3..=8).contains(&hex.len()) && hex.chars().all(|ch| ch.is_ascii_hexdigit())
    })
}

/// A page's own project list, reduced to what a row shows. The page may be
/// another server's code: anything odd is dropped rather than repaired, and
/// the size is bounded whatever it sends.
fn normalize_projects(raw: &Value) -> Vec<Value> {
    let mut seen = HashSet::new();
    let mut projects = Vec::new();
    let entries = raw.as_array().map(Vec::as_slice).unwrap_or_default();
    for entry in entries.iter().take(MAX_PROJECTS * 2) {
        if projects.len() >= MAX_PROJECTS {
            break;
        }
        let Some(id) = entry.get("id").and_then(project_id) else {
            continue;
        };
        let Some(name) = entry
            .get("name")
            .and_then(Value::as_str)
            .and_then(project_name)
        else {
            continue;
        };
        if !seen.insert(id) {
            continue;
        }
        let mut project = Map::new();
        project.insert("id".into(), id.into());
        project.insert("name".into(), name.into());
        if let Some(icon) = entry.get("icon").and_then(Value::as_str).filter(|icon| {
            !icon.is_empty() && icon.len() <= MAX_ICON_BYTES && !icon.chars().any(char::is_control)
        }) {
            project.insert("icon".into(), icon.into());
        }
        if let Some(value) = entry
            .get("color")
            .and_then(Value::as_str)
            .filter(|value| color(value))
        {
            project.insert("color".into(), value.into());
        }
        projects.push(Value::Object(project));
    }
    projects
}

struct Server {
    id: String,
    label: String,
    /// False once the pairing was revoked: opening leads to the server list.
    available: bool,
}

/// The saved servers, without a pairing that never completed.
fn servers(data_dir: &Path) -> Result<Vec<Server>, LinkError> {
    Ok(read_metadata(&metadata_path(data_dir))?
        .iter()
        .filter_map(|item| {
            let state = item.get("pairingState").and_then(Value::as_str);
            let id = item.get("id").and_then(Value::as_str)?;
            if id.is_empty() || state == Some("prepared") {
                return None;
            }
            let label = display_label(item);
            Some(Server {
                id: id.to_string(),
                label: if label.is_empty() {
                    "Polyth".into()
                } else {
                    label
                },
                available: state != Some("revoked")
                    && item.get("revoked").and_then(Value::as_bool) != Some(true),
            })
        })
        .collect())
}

/// What the page of `sender` may see: the server on screen, and the other
/// servers as `(connection id, zone)`. `None` until `sender` is allowed: it
/// then learns only that there is something to ask for, never a name.
fn visible(data_dir: &Path, sender: &str) -> Result<VisibleZones, LinkError> {
    let servers = servers(data_dir)?;
    let own = servers
        .iter()
        .find(|server| server.id == sender)
        .ok_or(LinkError::DeviceUnknown)?;
    let current = json!({ "kind": "link", "label": own.label });
    let mut others: Vec<&Server> = servers
        .iter()
        .filter(|server| server.id != sender)
        .collect();
    if others.is_empty() {
        return Ok((current, Some(Vec::new())));
    }
    if !flag(&read_records(data_dir), sender, "allowed") {
        return Ok((current, None));
    }
    // An order that does not move as servers are used.
    others.sort_by(|a, b| {
        a.label
            .to_lowercase()
            .cmp(&b.label.to_lowercase())
            .then_with(|| a.id.cmp(&b.id))
    });
    let records = keyed_records(data_dir, &others)?;
    let zones = others
        .into_iter()
        .map(|server| {
            let saved = record(&records, &server.id);
            let field = |name: &str| saved.and_then(|item| item.get(name)).cloned();
            let zone = json!({
                "key": field("key"),
                "kind": "link",
                "label": server.label,
                "available": server.available,
                "folded": flag(&records, &server.id, "folded"),
                "projects": field("projects").unwrap_or_else(|| json!([])),
                "reportedAt": field("reportedAt"),
            });
            (server.id.clone(), zone)
        })
        .collect();
    Ok((current, Some(zones)))
}

fn view(data_dir: &Path, sender: &str) -> Result<Value, LinkError> {
    let (current, zones) = visible(data_dir, sender)?;
    Ok(match zones {
        Some(zones) => {
            let zones: Vec<Value> = zones.into_iter().map(|(_, zone)| zone).collect();
            json!({ "access": "granted", "zones": zones, "current": current })
        }
        None => json!({ "access": "ask", "zones": [], "current": current }),
    })
}

/// The zone of `key` as `sender`'s page shows it, with its server's id.
fn visible_zone(
    data_dir: &Path,
    sender: &str,
    key: Option<&Value>,
) -> Result<(String, Value), LinkError> {
    let key = key
        .and_then(Value::as_str)
        .filter(|key| !key.is_empty())
        .ok_or(LinkError::Forbidden)?;
    visible(data_dir, sender)?
        .1
        .unwrap_or_default()
        .into_iter()
        .find(|(_, zone)| zone["key"] == key)
        .ok_or(LinkError::Forbidden)
}

pub(crate) fn handle(
    data_dir: &Path,
    method: &str,
    params: &Value,
    now: u64,
) -> Result<Value, LinkError> {
    let sender = params
        .get("connectionId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or(LinkError::DeviceUnknown)?;
    match method {
        "zones.view" => view(data_dir, sender),
        "zones.report" => {
            if !servers(data_dir)?.iter().any(|server| server.id == sender) {
                return Err(LinkError::DeviceUnknown);
            }
            let projects = Value::Array(normalize_projects(
                params.get("projects").unwrap_or(&Value::Null),
            ));
            // An unchanged list keeps its date and costs no write.
            let unchanged = record(&read_records(data_dir), sender)
                .is_some_and(|item| item.get("projects") == Some(&projects));
            if !unchanged {
                update(data_dir, sender, |item| {
                    item.insert("projects".into(), projects);
                    item.insert("reportedAt".into(), now.into());
                })?;
            }
            Ok(json!({ "ok": true }))
        }
        // The native plugin calls this only after the person agreed.
        "zones.allow" => {
            view(data_dir, sender)?;
            update(data_dir, sender, |item| {
                item.insert("allowed".into(), true.into());
            })?;
            view(data_dir, sender)
        }
        "zones.fold" => {
            let (id, _) = visible_zone(data_dir, sender, params.get("key"))?;
            let folded = params.get("folded").and_then(Value::as_bool) == Some(true);
            update(data_dir, &id, |item| {
                item.insert("folded".into(), folded.into());
            })?;
            view(data_dir, sender)
        }
        // The server the app may move to. The page builds no route: the app
        // opens the project only because this zone listed it.
        "zones.open" => {
            let (id, zone) = visible_zone(data_dir, sender, params.get("key"))?;
            if let Some(project) = params.get("projectId").filter(|value| !value.is_null()) {
                let listed = project_id(project).is_some()
                    && zone["projects"]
                        .as_array()
                        .is_some_and(|projects| projects.iter().any(|item| item["id"] == *project));
                if !listed {
                    return Err(LinkError::Forbidden);
                }
            }
            Ok(json!({ "connectionId": id, "available": zone["available"] }))
        }
        _ => Err(LinkError::PairingInvalid),
    }
}

/// A forgotten server takes its list, its fold and its permission with it.
pub(crate) fn forget(data_dir: &Path, id: &str) {
    let mut records = read_records(data_dir);
    let before = records.len();
    records.retain(|item| item.get("id").and_then(Value::as_str) != Some(id));
    if records.len() != before {
        let _ = write_metadata(&zones_path(data_dir), &records);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn pair(dir: &Path, servers: &[(&str, &str, &str)]) {
        let list: Vec<Value> = servers
            .iter()
            .map(|(id, label, state)| {
                json!({ "id": id, "hostEndpointId": id, "hostLabel": label, "pairingState": state })
            })
            .collect();
        write_metadata(&metadata_path(dir), &list).unwrap();
    }

    fn call(dir: &Path, method: &str, params: Value) -> Result<Value, LinkError> {
        handle(dir, method, &params, 1_000)
    }

    /// The key `sender`'s page holds for the zone named `label`.
    fn key(dir: &Path, sender: &str, label: &str) -> String {
        let view = call(dir, "zones.view", json!({ "connectionId": sender })).unwrap();
        let zones = view["zones"].as_array().unwrap();
        let zone = zones.iter().find(|zone| zone["label"] == label).unwrap();
        zone["key"].as_str().unwrap().to_string()
    }

    #[test]
    fn a_page_reads_the_other_servers_only_once_its_server_was_allowed() {
        let dir = tempdir().unwrap();
        pair(
            dir.path(),
            &[
                ("home-endpoint", "Home", "active"),
                ("team", "Team", "active"),
            ],
        );
        call(dir.path(), "zones.report", json!({ "connectionId": "home-endpoint", "projects": [{ "id": "p1", "name": "Site" }] })).unwrap();

        let asked = call(dir.path(), "zones.view", json!({ "connectionId": "team" })).unwrap();
        assert_eq!(asked["access"], "ask");
        assert_eq!(asked["zones"], json!([]));
        assert_eq!(asked["current"]["label"], "Team");
        assert!(!asked.to_string().contains("Home"));
        // Before the person agreed, nothing can be opened or folded either,
        // and a connection id is never a key.
        for method in ["zones.open", "zones.fold"] {
            assert_eq!(
                call(
                    dir.path(),
                    method,
                    json!({ "connectionId": "team", "key": "home-endpoint" })
                )
                .unwrap_err(),
                LinkError::Forbidden
            );
        }

        let granted = call(dir.path(), "zones.allow", json!({ "connectionId": "team" })).unwrap();
        assert_eq!(granted["access"], "granted");
        assert_eq!(granted["zones"][0]["label"], "Home");
        // The page names a zone by a random key that stays the same; the
        // connection id never reaches it.
        assert!(!granted.to_string().contains("home-endpoint"));
        assert_eq!(granted["zones"][0]["key"].as_str().unwrap().len(), 32);
        assert_eq!(key(dir.path(), "team", "Home"), granted["zones"][0]["key"]);
        assert_eq!(
            granted["zones"][0]["projects"],
            json!([{ "id": "p1", "name": "Site" }])
        );
        assert_eq!(granted["zones"][0]["reportedAt"], 1_000);
        // The permission is that server's alone.
        assert_eq!(
            call(
                dir.path(),
                "zones.view",
                json!({ "connectionId": "home-endpoint" })
            )
            .unwrap()["access"],
            "ask"
        );
    }

    #[test]
    fn a_reported_list_is_bounded_and_keeps_only_what_a_row_draws() {
        let dir = tempdir().unwrap();
        pair(
            dir.path(),
            &[("home", "Home", "active"), ("team", "Team", "active")],
        );
        let mut projects = vec![
            json!({ "id": "ok", "name": "  Web \n site ", "icon": "🌿", "color": "#0af", "path": "/srv/secret" }),
            json!({ "id": "ok", "name": "Twice" }),
            json!({ "id": "a/b", "name": "Slash" }),
            json!({ "id": "pct%2F", "name": "Escape" }),
            json!({ "id": "bell", "name": "Ding\u{7}" }),
            json!({ "id": "nameless", "name": "   " }),
            json!({ "id": "plain", "name": "Plain", "icon": "a\nb", "color": "red" }),
            json!("text"),
        ];
        projects.extend(
            (0..500).map(|index| json!({ "id": format!("n{index}"), "name": "x".repeat(300) })),
        );
        call(
            dir.path(),
            "zones.report",
            json!({ "connectionId": "home", "projects": projects }),
        )
        .unwrap();
        call(dir.path(), "zones.allow", json!({ "connectionId": "team" })).unwrap();
        let view = call(dir.path(), "zones.view", json!({ "connectionId": "team" })).unwrap();
        let listed = view["zones"][0]["projects"].as_array().unwrap();
        assert_eq!(
            listed[0],
            json!({ "id": "ok", "name": "Web site", "icon": "🌿", "color": "#0af" })
        );
        assert_eq!(listed[1], json!({ "id": "plain", "name": "Plain" }));
        assert!(listed.len() <= MAX_PROJECTS);
        assert_eq!(
            listed[2]["name"].as_str().unwrap().chars().count(),
            MAX_NAME_CHARS
        );
        assert!(!view.to_string().contains("secret"));
    }

    #[test]
    fn a_click_goes_only_to_a_listed_project_of_a_visible_zone() {
        let dir = tempdir().unwrap();
        pair(
            dir.path(),
            &[
                ("home", "Home", "active"),
                ("team", "Team", "active"),
                ("old", "Old", "revoked"),
            ],
        );
        call(
            dir.path(),
            "zones.report",
            json!({ "connectionId": "home", "projects": [{ "id": "p1", "name": "Site" }] }),
        )
        .unwrap();
        call(dir.path(), "zones.allow", json!({ "connectionId": "team" })).unwrap();
        let open = |key: &str, project: Value| {
            call(
                dir.path(),
                "zones.open",
                json!({ "connectionId": "team", "key": key, "projectId": project }),
            )
        };
        let home = key(dir.path(), "team", "Home");
        let old = key(dir.path(), "team", "Old");
        assert_eq!(
            open(&home, json!("p1")).unwrap(),
            json!({ "connectionId": "home", "available": true })
        );
        assert_eq!(open(&home, Value::Null).unwrap()["connectionId"], "home");
        assert_eq!(open(&old, Value::Null).unwrap()["available"], false);
        assert_eq!(open(&home, json!("p2")).unwrap_err(), LinkError::Forbidden);
        assert_eq!(open(&home, json!(7)).unwrap_err(), LinkError::Forbidden);
        // Its own server, a connection id and a made-up key are not zones.
        for key in ["team", "home", "link:home", ""] {
            assert_eq!(open(key, Value::Null).unwrap_err(), LinkError::Forbidden);
        }
        // A page of a server this app does not know speaks for nobody.
        assert_eq!(
            call(
                dir.path(),
                "zones.report",
                json!({ "connectionId": "ghost", "projects": [] })
            )
            .unwrap_err(),
            LinkError::DeviceUnknown
        );
    }

    #[test]
    fn zones_keep_their_order_fold_and_forget() {
        let dir = tempdir().unwrap();
        pair(
            dir.path(),
            &[
                ("c", "beta", "active"),
                ("b", "Alpha", "active"),
                ("a", "Here", "active"),
                ("d", "Draft", "prepared"),
            ],
        );
        // Alone, a server has nothing to ask for.
        let solo = tempdir().unwrap();
        pair(solo.path(), &[("a", "Here", "active")]);
        assert_eq!(
            call(solo.path(), "zones.view", json!({ "connectionId": "a" })).unwrap()["access"],
            "granted"
        );

        call(dir.path(), "zones.allow", json!({ "connectionId": "a" })).unwrap();
        let beta = key(dir.path(), "a", "beta");
        let folded = call(
            dir.path(),
            "zones.fold",
            json!({ "connectionId": "a", "key": beta, "folded": true }),
        )
        .unwrap();
        let labels: Vec<&str> = folded["zones"]
            .as_array()
            .unwrap()
            .iter()
            .map(|zone| zone["label"].as_str().unwrap())
            .collect();
        assert_eq!(labels, ["Alpha", "beta"]);
        assert_eq!(folded["zones"][1]["folded"], true);
        assert_eq!(folded["zones"][0]["reportedAt"], Value::Null);

        call(
            dir.path(),
            "zones.report",
            json!({ "connectionId": "c", "projects": [{ "id": "p", "name": "P" }] }),
        )
        .unwrap();
        let before = std::fs::read(zones_path(dir.path())).unwrap();
        handle(
            dir.path(),
            "zones.report",
            &json!({ "connectionId": "c", "projects": [{ "id": "p", "name": "P" }] }),
            9_000,
        )
        .unwrap();
        assert_eq!(std::fs::read(zones_path(dir.path())).unwrap(), before);

        for id in ["a", "b", "c"] {
            forget(dir.path(), id);
        }
        let text = std::fs::read_to_string(zones_path(dir.path())).unwrap();
        assert_eq!(text, "[]");
        // A damaged file costs the snapshots, not the connections.
        std::fs::write(zones_path(dir.path()), "{").unwrap();
        assert_eq!(
            call(dir.path(), "zones.view", json!({ "connectionId": "a" })).unwrap()["access"],
            "ask"
        );
    }
}

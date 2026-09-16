//! Safe management IPC. Prepared records and secrets never leave backend memory.
use provider_store::{commit, edit, migration, native, plan::{Plan, Preview, Selection, Source}};
use std::{collections::HashMap, path::PathBuf, sync::{Mutex, OnceLock}};

static PLANS: OnceLock<Mutex<HashMap<String,Plan>>> = OnceLock::new();
fn plans()->&'static Mutex<HashMap<String,Plan>> {PLANS.get_or_init(||Mutex::new(HashMap::new()))}
fn target()->Result<PathBuf,String>{provider_store::paths::default_db_path().map_err(|_|"provider_path_unavailable".into())}
pub fn require_claude(app:&str)->Result<(),String>{if app=="claude"{Ok(())}else{Err("此操作仅适用于 Claude 渠道".into())}}

#[tauri::command]
pub fn preview_import(mut source:Source)->Result<Preview,String>{
    let home=crate::paths::home_dir()?;
    match &mut source {
        Source::CcSwitch{path} if path.as_os_str().is_empty()=>*path=home.join(".cc-switch/cc-switch.db"),
        Source::Claude{path} if path.as_os_str().is_empty()=>*path=home.join(".claude/settings.json"),
        Source::Codex{config,auth,..}=>{
            if config.as_os_str().is_empty(){*config=home.join(".codex/config.toml");}
            if auth.as_os_str().is_empty(){*auth=config.with_file_name("auth.json");}
        },
        _=>{}
    }
    let plan=Plan::prepare(source,&target()?,|name|std::env::var(name).ok()).map_err(|e|e.to_string())?;
    let preview=plan.preview();
    let mut plans=plans().lock().map_err(|_|"plan_unavailable")?;
    if plans.len()>=32{return Err("plan_limit: 请关闭已有导入预览后重试".into());}
    plans.insert(plan.id.clone(),plan);Ok(preview)
}
#[tauri::command]
pub fn select_import(plan_id:String,selected:Vec<String>,replace:bool)->Result<Selection,String>{
    plans().lock().map_err(|_|"plan_unavailable")?.get_mut(&plan_id).ok_or("plan_not_found")?.select(&selected,replace).map_err(|e|e.to_string())
}
#[tauri::command]
pub async fn apply_import(plan_id:String,selected:Vec<String>,replace:bool)->Result<commit::Outcome,String>{
    let plan=plans().lock().map_err(|_|"plan_unavailable")?.remove(&plan_id).ok_or("plan_not_found")?;
    tauri::async_runtime::spawn_blocking(move||native::apply_plan(&plan,&selected,replace).map_err(|e|e.to_string())).await.map_err(|_|"provider_operation_failed".to_string())?
}
#[tauri::command]
pub fn cancel_import(plan_id:String)->Result<(),String>{plans().lock().map_err(|_|"plan_unavailable")?.remove(&plan_id);Ok(())}
#[tauri::command]
pub fn provider_edit_view(app_type:String,id:String)->Result<edit::View,String>{edit::view(&target()?,&app_type,&id).map_err(|e|e.to_string())}
#[tauri::command]
pub async fn save_provider(input:edit::Input)->Result<commit::Outcome,String>{
    let path=target()?;
    tauri::async_runtime::spawn_blocking(move||native::save(&path,input).map_err(|e|e.to_string())).await.map_err(|_|"provider_operation_failed".to_string())?
}
#[tauri::command]
pub async fn remove_provider(app_type:String,id:String)->Result<commit::DeleteOutcome,String>{
    let path=target()?;
    tauri::async_runtime::spawn_blocking(move||native::remove(&path,&app_type,&id).map_err(|e|e.to_string())).await.map_err(|_|"provider_operation_failed".to_string())?
}
#[tauri::command]
pub fn credential_status()->Result<migration::Status,String>{migration::status(&target()?).map_err(|e|e.to_string())}
#[tauri::command]
pub async fn migrate_credentials()->Result<migration::MigrationOutcome,String>{
    let path=target()?;
    tauri::async_runtime::spawn_blocking(move||native::migrate(&path).map_err(|e|e.to_string())).await.map_err(|_|"provider_operation_failed".to_string())?
}

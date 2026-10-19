#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, Command, Stdio},
    sync::Mutex,
};
use tauri::Manager;

#[derive(Clone, serde::Serialize)]
struct Connection {
    url: String,
    token: String,
}
struct Backend {
    child: Mutex<Child>,
    connection: Connection,
}
#[tauri::command]
fn connection(state: tauri::State<Backend>) -> Connection {
    state.connection.clone()
}

fn main() {
    let smoke = std::env::var("SKEIN_EXAMPLE_SMOKE").as_deref() == Ok("1");
    let app = tauri::Builder::default()
        .setup(move |app| {
            let resource = app.path().resource_dir()?.join("backend");
            let application_data = app.path().app_data_dir()?;
            let directory = if smoke {
                application_data
                    .join("smoke")
                    .join(uuid::Uuid::new_v4().to_string())
            } else {
                application_data
            };
            std::fs::create_dir_all(&directory)?;
            let token = uuid::Uuid::new_v4().to_string();
            let node = resource.join(if cfg!(windows) { "node.exe" } else { "node" });
            let mut child = Command::new(node)
                .arg(resource.join("backend.js"))
                .env("SKEIN_EXAMPLE_DATA", &directory)
                .env("SKEIN_EXAMPLE_TOKEN", &token)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn()?;
            let mut reader = BufReader::new(child.stdout.take().ok_or("Missing backend stdout")?);
            let mut line = String::new();
            reader.read_line(&mut line)?;
            let ready: serde_json::Value = serde_json::from_str(&line)?;
            let connection = Connection {
                url: ready["url"]
                    .as_str()
                    .ok_or("Missing backend URL")?
                    .to_string(),
                token,
            };
            if smoke {
                // The packaged Node sidecar performs the SDK workflow and credential checks.
                for line in reader.lines() {
                    println!("{}", line?);
                }
                let status = child.wait()?;
                std::fs::remove_dir_all(&directory)?;
                app.handle().exit(if status.success() { 0 } else { 1 });
            } else {
                app.manage(Backend {
                    child: Mutex::new(child),
                    connection,
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![connection])
        .build(tauri::generate_context!())
        .expect("Could not build local desktop app");
    app.run(|app, event| {
        if let tauri::RunEvent::Exit = event {
            if let Some(backend) = app.try_state::<Backend>() {
                if let Ok(mut child) = backend.child.lock() {
                    if let Some(stdin) = child.stdin.as_mut() {
                        let _ = stdin.write_all(b"shutdown\n");
                    }
                    // Bound shutdown even when a graph/tool refuses to stop.
                    for _ in 0..50 {
                        if child.try_wait().ok().flatten().is_some() {
                            return;
                        }
                        std::thread::sleep(std::time::Duration::from_millis(100));
                    }
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        }
    });
}

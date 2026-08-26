// 发布构建里不额外弹控制台窗口。macOS 上这条属性无副作用，
// 保留它是为了和 Windows 侧的写法保持一致（DESIGN.md 5 节：差异只允许出现在平台差异表里）。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    claude1_desktop_lib::run();
}

// 发布构建里不额外弹控制台窗口：Windows 上这条属性是必须的，
// 少了它每次启动都会先闪一个黑色控制台窗口。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    claude1_desktop_lib::run();
}

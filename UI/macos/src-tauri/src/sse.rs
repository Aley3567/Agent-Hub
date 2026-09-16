//! Server-Sent Events 解析（纯函数、无 IO，可纯单测）。
//!
//! 按 SSE 规范实现：行分隔符 `\n` / `\r\n` / `\r`；`event:` / `data:` / `id:` /
//! `retry:` 字段；`:` 开头是注释行；空行分帧；多行 `data:` 用 `\n` 拼接；流首的
//! UTF-8 BOM 忽略。
//!
//! 一个事件可能被切成任意多段到达，`feed` 因此保留跨 chunk 的半帧——半帧不落地成
//! 事件，`finish` 直接丢弃它，不伪造一个完整事件出来（截断必须可观测）。

/// 流首的 UTF-8 BOM，按规范忽略。
const BOM: [u8; 3] = [0xEF, 0xBB, 0xBF];

/// 一个完整解出的事件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Event {
    /// `event:` 字段；上游没给时是规范默认的 `message`
    pub event: String,
    /// 多行 `data:` 已按 `\n` 拼接，且去掉了行尾那个分隔用的 `\n`
    pub data: String,
}

/// 增量式的 SSE 解析器。
#[derive(Debug)]
pub struct Parser {
    /// 还没凑成完整一行的字节（跨 chunk 的半帧）
    pending: Vec<u8>,
    /// 当前帧的 `event:` 值
    event: String,
    /// 当前帧累积的 data 行，每行以 `\n` 结尾
    data: String,
    /// 还没喂过字节：只有第一个 chunk 才需要处理 BOM
    at_start: bool,
}

impl Parser {
    pub fn new() -> Self {
        Self {
            pending: Vec::new(),
            event: String::new(),
            data: String::new(),
            at_start: true,
        }
    }

    /// 喂一段字节，返回本次能完整解出的事件。
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<Event> {
        let mut bytes = chunk;
        if self.at_start {
            self.at_start = false;
            if let Some(rest) = bytes.strip_prefix(&BOM) {
                bytes = rest;
            }
        }
        self.pending.extend_from_slice(bytes);

        let mut events = Vec::new();
        loop {
            let Some(index) = self
                .pending
                .iter()
                .position(|byte| *byte == b'\n' || *byte == b'\r')
            else {
                break;
            };
            // `\r` 可能是 `\r\n` 的前半，等下一个 chunk 才能判定行尾长度
            if self.pending[index] == b'\r' && index + 1 == self.pending.len() {
                break;
            }
            let crlf = self.pending[index] == b'\r' && self.pending.get(index + 1) == Some(&b'\n');
            let line = self.pending[..index].to_vec();
            self.pending.drain(..index + if crlf { 2 } else { 1 });
            self.consume_line(&line, &mut events);
        }
        events
    }

    /// 流结束时调用：丢弃未完成的半帧，不伪造完整事件。
    pub fn finish(self) {}

    fn consume_line(&mut self, line: &[u8], events: &mut Vec<Event>) {
        if line.is_empty() {
            self.dispatch(events);
            return;
        }
        if line[0] == b':' {
            // 注释行（也用于心跳）
            return;
        }
        let text = String::from_utf8_lossy(line);
        let (field, value) = match text.find(':') {
            Some(index) => {
                let value = &text[index + 1..];
                (&text[..index], value.strip_prefix(' ').unwrap_or(value))
            }
            // 没有冒号：整行是字段名，值是空串
            None => (&text[..], ""),
        };
        match field {
            "event" => self.event = value.to_string(),
            "data" => {
                self.data.push_str(value);
                self.data.push('\n');
            }
            // `id` / `retry` 被规范识别，但 Event 只带 event + data：
            // 上游的 message id 在 data 的 JSON 里，重连间隔由调用方决定。
            _ => {}
        }
    }

    fn dispatch(&mut self, events: &mut Vec<Event>) {
        if self.data.is_empty() {
            // 规范：data 为空的空行不派发事件，只重置事件名
            self.event.clear();
            return;
        }
        self.data.pop();
        events.push(Event {
            event: if self.event.is_empty() {
                "message".to_string()
            } else {
                std::mem::take(&mut self.event)
            },
            data: std::mem::take(&mut self.data),
        });
        self.event.clear();
    }
}

impl Default for Parser {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一段带注释、未知字段、多行 data 与自定义行尾的 fixture。
    const FIXTURE: &str = "event: message_start\n\
data: {\"type\":\"message_start\"}\n\
\n\
: keep-alive\n\
event: content_block_delta\n\
data: {\"type\":\"content_block_delta\",\n\
data: \"delta\":{\"text\":\"你好\"}}\n\
\n\
id: 42\n\
retry: 1000\n\
event: message_stop\n\
data: {\"type\":\"message_stop\"}\r\n\
\r\n\
event: bare\n\
data:\n\
\n";

    fn names(events: &[Event]) -> Vec<String> {
        events
            .iter()
            .map(|event| format!("{}|{}", event.event, event.data))
            .collect()
    }

    fn parse_in_chunks(size: usize) -> Vec<Event> {
        let mut parser = Parser::new();
        let mut events = Vec::new();
        for chunk in FIXTURE.as_bytes().chunks(size) {
            events.extend(parser.feed(chunk));
        }
        parser.finish();
        events
    }

    #[test]
    fn any_chunk_split_yields_the_same_events() {
        let whole = parse_in_chunks(FIXTURE.len());
        assert_eq!(whole.len(), 4, "{:?}", names(&whole));
        for size in [1, 3, 7, 64] {
            assert_eq!(names(&parse_in_chunks(size)), names(&whole), "切法 {size}");
        }
    }

    #[test]
    fn multiline_data_is_joined_with_newlines() {
        let events = parse_in_chunks(FIXTURE.len());
        assert_eq!(events[1].event, "content_block_delta");
        assert_eq!(
            events[1].data,
            "{\"type\":\"content_block_delta\",\n\"delta\":{\"text\":\"你好\"}}"
        );
    }

    #[test]
    fn comment_and_unknown_fields_do_not_become_events() {
        let events = parse_in_chunks(FIXTURE.len());
        assert_eq!(events[0].event, "message_start");
        assert!(events.iter().all(|event| !event.data.contains("keep-alive")));
        assert_eq!(events[2].event, "message_stop");
        // `data:` 空值也派发，内容是空串
        assert_eq!(events[3].event, "bare");
        assert_eq!(events[3].data, "");
    }

    #[test]
    fn an_event_without_a_name_defaults_to_message() {
        let mut parser = Parser::new();
        let events = parser.feed(b"data: {\"type\":\"ping\"}\n\n");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event, "message");
    }

    #[test]
    fn a_blank_line_without_data_dispatches_nothing() {
        let mut parser = Parser::new();
        assert!(parser.feed(b"event: ping\n\n").is_empty());
        assert!(parser.feed(b": comment\n\n").is_empty());
    }

    #[test]
    fn eof_in_the_middle_of_a_frame_discards_the_half_frame() {
        let mut parser = Parser::new();
        assert!(parser.feed(b"event: content_block_delta\ndata: {\"partial\":").is_empty());
        parser.finish();
        // 半帧不落地：再来一个全新 Parser 也不会被上一份残留污染
        let fresh = Parser::new().feed(b"data: x\n\n");
        assert_eq!(fresh.len(), 1);
    }

    #[test]
    fn a_trailing_carriage_return_split_across_chunks_is_one_line_ending() {
        let mut parser = Parser::new();
        assert!(parser.feed(b"data: a\r").is_empty());
        let events = parser.feed(b"\ndata: b\r\n\r\n");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].data, "a\nb");
    }

    #[test]
    fn a_leading_bom_is_ignored() {
        let mut parser = Parser::new();
        let mut bytes = BOM.to_vec();
        bytes.extend_from_slice(b"event: message_stop\ndata: {}\n\n");
        let events = parser.feed(&bytes);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event, "message_stop");
    }

    #[test]
    fn bare_carriage_returns_separate_lines() {
        let mut parser = Parser::new();
        // 末字节的裸 `\r` 只有在 EOF 才能判定，所以这里补一个 `\n` 收尾
        let events = parser.feed(b"data: a\rdata: b\r\r\n");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].data, "a\nb");
    }
}

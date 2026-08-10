import Foundation

/// How a message is presented in a notification.
///
/// A port of `src/lib/notificationPreview.ts`, which is itself the source the
/// Android service's text pipeline was ported from. The shape mirrors Android's
/// `MessagingStyle`, because that is what makes a conversation notification
/// legible: a ROOM titles the notification and the sender goes inside the body
/// ("#general" + "alex: shipped it"), while a DM has no room, so the SENDER
/// titles it and the body is the bare message.
///
/// Pure and store-free: the caller resolves names and room titles however its
/// environment can and hands them in already resolved.
enum NotificationPreview {

    /// Longest body shown before eliding, matching `CONTENT_CAP` on Android.
    static let contentCap = 140

    /// NIP-17 file message — its content is a URL, not prose.
    private static let kindDmFile = 15

    /// Media extensions the UI would render as an embed, so they carry no
    /// textual meaning in a notification. Mirrors `ALL_MEDIA_EXTS`.
    private static let mediaExtensions: Set<String> = [
        "jpg", "jpeg", "png", "gif", "webp", "svg", "avif",
        "mp4", "webm", "mov", "qt", "avi", "mkv", "flv",
        "mp3", "mpga", "wav", "ogg", "oga", "flac", "m4a", "aac", "opus", "weba",
        "xdc",
    ]

    /// Which plane a message arrived on — DMs present differently.
    enum Plane {
        case nip29
        case dm
        case c2
    }

    struct Message {
        var plane: Plane
        var kind: Int
        var content: String
        var authorName: String
        var roomTitle: String?
        var mention: Bool = false
        var reaction: Bool = false
        var threadReply: Bool = false
        var imetaMime: String?
        /// Resolved names for the pubkeys the content mentions, if any.
        var mentionNames: [String: String] = [:]
    }

    struct Presented {
        let title: String
        let body: String
    }

    // MARK: - Content cleaning

    /// Strip inline media URLs and resolve `nostr:npub…` mentions to `@name`.
    ///
    /// "lol https://blossom.example/abcd.jpg" reads "lol". Non-media links (an
    /// article URL) are kept verbatim. A mention whose author cannot be named
    /// keeps its raw token rather than showing a wrong one.
    static func cleanContent(_ content: String, names: [String: String] = [:]) -> String {
        guard !content.isEmpty else { return "" }
        var out = stripMediaUrls(content)
        out = resolveMentions(out, names: names)
        return out.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Remove media URLs from the prose.
    private static func stripMediaUrls(_ content: String) -> String {
        var out = ""
        var index = content.startIndex
        while index < content.endIndex {
            guard let range = nextUrl(in: content, from: index) else {
                out += content[index...]
                break
            }
            out += content[index..<range.lowerBound]
            let url = String(content[range])
            if mediaExtension(of: url) == nil {
                out += url
            } else {
                // Drop the URL and the whitespace run immediately before it, so
                // stripping one out of "a <url> b" doesn't leave a double space.
                while let last = out.last, last == " " || last == "\t" { out.removeLast() }
            }
            index = range.upperBound
        }
        return out
    }

    /// The next `http(s)://…` run in `content`, from `start`.
    private static func nextUrl(
        in content: String, from start: String.Index
    ) -> Range<String.Index>? {
        var index = start
        while index < content.endIndex {
            if content[index...].hasPrefix("http://") || content[index...].hasPrefix("https://") {
                var end = index
                while end < content.endIndex, !content[end].isWhitespace { end = content.index(after: end) }
                return index..<end
            }
            index = content.index(after: index)
        }
        return nil
    }

    /// The media extension a URL ends in (ignoring a query string), or nil.
    private static func mediaExtension(of url: String) -> String? {
        var path = url
        if let query = path.firstIndex(of: "?") { path = String(path[path.startIndex..<query]) }
        guard let dot = path.lastIndex(of: ".") else { return nil }
        let ext = String(path[path.index(after: dot)...]).lowercased()
        return mediaExtensions.contains(ext) ? ext : nil
    }

    /// Replace `nostr:npub1…` / `nostr:nprofile1…` tokens with `@name` where a
    /// name is known, leaving the token alone otherwise.
    private static func resolveMentions(_ content: String, names: [String: String]) -> String {
        guard !names.isEmpty || content.contains("npub1") || content.contains("nprofile1") else {
            return content
        }
        var out = ""
        var index = content.startIndex
        while index < content.endIndex {
            guard let token = nextMention(in: content, from: index) else {
                out += content[index...]
                break
            }
            out += content[index..<token.lowerBound]
            let raw = String(content[token])
            if let pubkey = Bech32.mentionPubkey(raw), let name = names[pubkey] {
                out += "@\(name)"
            } else {
                out += raw
            }
            index = token.upperBound
        }
        return out
    }

    private static func nextMention(
        in content: String, from start: String.Index
    ) -> Range<String.Index>? {
        var index = start
        while index < content.endIndex {
            let rest = content[index...]
            let withPrefix = rest.lowercased().hasPrefix("nostr:")
            let bodyStart = withPrefix ? content.index(index, offsetBy: 6) : index
            if bodyStart < content.endIndex {
                let body = content[bodyStart...].lowercased()
                if body.hasPrefix("npub1") || body.hasPrefix("nprofile1") {
                    var end = bodyStart
                    while end < content.endIndex, isBech32Character(content[end]) {
                        end = content.index(after: end)
                    }
                    return index..<end
                }
            }
            index = content.index(after: index)
        }
        return nil
    }

    private static func isBech32Character(_ c: Character) -> Bool {
        guard let ascii = c.asciiValue else { return false }
        switch ascii {
        case 0x30...0x39, 0x41...0x5A, 0x61...0x7A: return true
        default: return false
        }
    }

    // MARK: - Media labels

    /// Human label for the media a message carries, so a body left empty by
    /// `cleanContent` reads "Sent an image" rather than "Sent a message".
    ///
    /// The imeta `m` MIME wins over the URL extension: an encrypted attachment's
    /// blob URL carries no media extension at all, and a voice message recorded
    /// into a `.webm` container is only distinguishable from video by its MIME.
    static func mediaLabel(imetaMime: String?, content: String) -> String? {
        if let byMime = label(forMime: imetaMime) { return byMime }
        guard !content.isEmpty else { return nil }
        var index = content.startIndex
        while let range = nextUrl(in: content, from: index) {
            if let ext = mediaExtension(of: String(content[range])) { return label(forExtension: ext) }
            index = range.upperBound
        }
        return nil
    }

    private static func label(forMime mime: String?) -> String? {
        guard let mime = mime?.lowercased(), !mime.isEmpty else { return nil }
        if mime == "image/gif" { return "a GIF" }
        if mime.hasPrefix("image/") { return "an image" }
        if mime.hasPrefix("video/") { return "a video" }
        if mime.hasPrefix("audio/") { return "a voice message" }
        if mime == "application/x-webxdc" { return "a game" }
        return nil
    }

    private static func label(forExtension ext: String) -> String? {
        if ext == "gif" { return "a GIF" }
        if ext == "xdc" { return "a game" }
        return label(forMime: coarseMime(ext))
    }

    private static func coarseMime(_ ext: String) -> String? {
        switch ext {
        case "jpg", "jpeg", "png", "gif", "webp", "svg", "avif": return "image/"
        case "mp4", "webm", "mov", "qt", "avi", "mkv", "flv": return "video/"
        case "mp3", "mpga", "wav", "ogg", "oga", "flac", "m4a", "aac", "opus", "weba":
            return "audio/"
        default: return nil
        }
    }

    // MARK: - Message shape

    /// The MIME of the first NIP-92 `imeta` attachment, when one is declared.
    static func firstImetaMime(_ tags: [[String]]) -> String? {
        for tag in tags where tag.first == "imeta" {
            for entry in tag.dropFirst() where entry.hasPrefix("m ") {
                let mime = String(entry.dropFirst(2)).trimmingCharacters(in: .whitespaces)
                if !mime.isEmpty { return mime }
            }
        }
        return nil
    }

    /// Whether a message is a reply inside a thread rather than to the room:
    /// a kind-1111 NIP-22 comment always is, and a Concord chat message carries
    /// the thread root in the uppercase `E` tag.
    static func isThreadReply(kind: Int, tags: [[String]]) -> Bool {
        if kind == 1111 { return true }
        return tags.contains { $0.count > 1 && $0[0] == "E" && !$0[1].isEmpty }
    }

    /// Elide to `contentCap`.
    static func truncate(_ text: String, max: Int = contentCap) -> String {
        guard text.count > max else { return text }
        return String(text.prefix(max - 1)) + "…"
    }

    /// Normalize a kind-7 reaction's content to the emoji a body can show.
    static func reactionEmoji(_ content: String?) -> String {
        let raw = (content ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if raw.isEmpty || raw == "+" { return "👍" }
        if raw == "-" { return "👎" }
        // A `:shortcode:` custom emoji has no glyph here; the bare word reads
        // better than the colons.
        if raw.count > 2, raw.hasPrefix(":"), raw.hasSuffix(":") {
            let inner = String(raw.dropFirst().dropLast())
            if !inner.contains(":") && !inner.contains(" ") { return inner }
        }
        return raw
    }

    // MARK: - Presentation

    /// The body text for one message line, before the sender is prefixed.
    static func messageLine(_ msg: Message) -> String {
        if msg.reaction { return "Reacted \(reactionEmoji(msg.content)) to your message" }

        let cleaned = truncate(cleanContent(msg.content, names: msg.mentionNames))
        var text: String
        if !cleaned.isEmpty {
            text = msg.threadReply ? "Replied in thread: \(cleaned)" : cleaned
        } else if let label = mediaLabel(imetaMime: msg.imetaMime, content: msg.content) {
            // Stripping the URLs left nothing: name the media rather than the act.
            text = "Sent \(label)"
        } else if msg.kind == kindDmFile {
            text = "Sent a file"
        } else if msg.threadReply {
            text = "Replied in thread"
        } else {
            text = msg.plane == .dm ? "Sent you a direct message" : "Sent a message"
        }

        // A mention is the reason this notification interrupted at all; say so
        // where the room, not the sender, is the title.
        if msg.mention && msg.plane != .dm { return "@you \(text)" }
        return text
    }

    /// The line `present` would show, attributed to its sender where the title
    /// is the room.
    static func attributedLine(_ msg: Message) -> String {
        let line = messageLine(msg)
        return msg.plane == .dm ? line : "\(msg.authorName): \(line)"
    }

    /// Title and body for one message, in the MessagingStyle shape.
    static func present(_ msg: Message) -> Presented {
        let isDm = msg.plane == .dm
        return Presented(
            title: isDm ? msg.authorName : (msg.roomTitle.flatMap { $0.isEmpty ? nil : $0 } ?? "Chat"),
            body: attributedLine(msg)
        )
    }
}

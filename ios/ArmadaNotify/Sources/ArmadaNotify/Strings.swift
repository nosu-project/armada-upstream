import Foundation

/// Every text the extension shows, in the app's language.
///
/// The iOS copy of the `notification.*` messages (`notificationMessages` in
/// `src/lib/notificationPreview.ts`), which Android's `strings.xml` also
/// carries; the three must stay in step, and `npm run i18n:check` fails when
/// this table and the catalogs disagree. An in-code table rather than
/// `Localizable.strings`: the language is the APP's choice, handed over in the
/// config, not the device's, and a bundle lookup would leave the Linux suite
/// testing nothing the extension reads.
struct Strings {

    enum Key: String, CaseIterable {
        case reacted
        case repliedInThreadWith
        case repliedInThread
        case sentGif
        case sentImage
        case sentVideo
        case sentVoice
        case sentGame
        case sentFile
        case sentDirectMessage
        case sentMessage
        case mentionedYou
        case attributed
        case chat
        case anonymous
        case appName
        case messagesSynced
        case newMessage
        case newDirectMessage
        case newCommunityMessage
        case newChannelMessage
        case someoneMentionedYou
        case messageRequests
        case newMessageRequestOne
        case newMessageRequestOther
        case roomTitle
        case channelTitle
    }

    /// The language actually used: a supported code, or `en`.
    let language: String
    private let table: [Key: String]

    static let fallbackLanguage = "en"
    static let english = Strings(locale: nil)

    /// `locale` is the app's language code; a region (`de-AT`) is ignored, and
    /// an absent or unsupported one reads English.
    init(locale: String?) {
        let code = locale?
            .split(whereSeparator: { $0 == "-" || $0 == "_" }).first
            .map { $0.lowercased() }
        if let code, let table = Self.tables[code] {
            language = code
            self.table = table
        } else {
            language = Self.fallbackLanguage
            table = Self.tables[Self.fallbackLanguage]!
        }
    }

    /// The message for `key` with its `{name}` placeholders filled in.
    ///
    /// One pass over the TEMPLATE, never a replace over the result: an argument
    /// is a sender's name or text, and one that spells `{text}` must not be
    /// substituted into.
    func format(_ key: Key, _ args: [String: String] = [:]) -> String {
        let template = table[key] ?? Self.tables[Self.fallbackLanguage]![key] ?? ""
        var out = ""
        var index = template.startIndex
        while index < template.endIndex {
            if template[index] == "{",
               let close = template[index...].firstIndex(of: "}"),
               let value = args[String(template[template.index(after: index)..<close])] {
                out += value
                index = template.index(after: close)
            } else {
                out.append(template[index])
                index = template.index(after: index)
            }
        }
        return out
    }

    // MARK: - Accessors

    func reacted(emoji: String) -> String { format(.reacted, ["emoji": emoji]) }
    func repliedInThread(text: String) -> String { format(.repliedInThreadWith, ["text": text]) }
    var repliedInThread: String { format(.repliedInThread) }

    /// "Sent …" as one sentence per kind; the languages inflect the object.
    func sent(_ media: NotificationPreview.MediaKind) -> String {
        switch media {
        case .gif: return format(.sentGif)
        case .image: return format(.sentImage)
        case .video: return format(.sentVideo)
        case .voice: return format(.sentVoice)
        case .game: return format(.sentGame)
        }
    }

    var sentFile: String { format(.sentFile) }
    var sentDirectMessage: String { format(.sentDirectMessage) }
    var sentMessage: String { format(.sentMessage) }
    func mentionedYou(text: String) -> String { format(.mentionedYou, ["text": text]) }
    func attributed(name: String, text: String) -> String {
        format(.attributed, ["name": name, "text": text])
    }
    var chat: String { format(.chat) }
    var anonymous: String { format(.anonymous) }
    var appName: String { format(.appName) }
    var messagesSynced: String { format(.messagesSynced) }
    var newMessage: String { format(.newMessage) }
    var newDirectMessage: String { format(.newDirectMessage) }
    var newCommunityMessage: String { format(.newCommunityMessage) }
    var newChannelMessage: String { format(.newChannelMessage) }
    var someoneMentionedYou: String { format(.someoneMentionedYou) }
    var messageRequests: String { format(.messageRequests) }
    /// `{count, plural, …}` in the web catalog; only one and many are ever shown here.
    func newMessageRequest(many: Bool) -> String {
        format(many ? .newMessageRequestOther : .newMessageRequestOne)
    }
    func roomTitle(community: String, channel: String) -> String {
        format(.roomTitle, ["community": community, "channel": channel])
    }
    func channelTitle(channel: String) -> String { format(.channelTitle, ["channel": channel]) }

    // MARK: - Tables

    static let tables: [String: [Key: String]] = [
        "en": [
            .reacted: "Reacted {emoji} to your message",
            .repliedInThreadWith: "Replied in thread: {text}",
            .repliedInThread: "Replied in thread",
            .sentGif: "Sent a GIF",
            .sentImage: "Sent an image",
            .sentVideo: "Sent a video",
            .sentVoice: "Sent a voice message",
            .sentGame: "Sent a game",
            .sentFile: "Sent a file",
            .sentDirectMessage: "Sent you a direct message",
            .sentMessage: "Sent a message",
            .mentionedYou: "@you {text}",
            .attributed: "{name}: {text}",
            .chat: "Chat",
            .anonymous: "Anonymous",
            .appName: "Armada",
            .messagesSynced: "Messages synced",
            .newMessage: "New message",
            .newDirectMessage: "New direct message",
            .newCommunityMessage: "New message in a community",
            .newChannelMessage: "New message in a channel",
            .someoneMentionedYou: "Someone mentioned you",
            .messageRequests: "Message requests",
            .newMessageRequestOne: "You have a new message request",
            .newMessageRequestOther: "You have new message requests",
            .roomTitle: "{community} / #{channel}",
            .channelTitle: "#{channel}",
        ],
        "de": [
            .reacted: "Hat mit {emoji} auf deine Nachricht reagiert",
            .repliedInThreadWith: "Im Thread geantwortet: {text}",
            .repliedInThread: "Im Thread geantwortet",
            .sentGif: "Hat ein GIF gesendet",
            .sentImage: "Hat ein Bild gesendet",
            .sentVideo: "Hat ein Video gesendet",
            .sentVoice: "Hat eine Sprachnachricht gesendet",
            .sentGame: "Hat ein Spiel gesendet",
            .sentFile: "Hat eine Datei gesendet",
            .sentDirectMessage: "Hat dir eine Direktnachricht gesendet",
            .sentMessage: "Hat eine Nachricht gesendet",
            .mentionedYou: "@du {text}",
            .attributed: "{name}: {text}",
            .chat: "Chat",
            .anonymous: "Anonym",
            .appName: "Armada",
            .messagesSynced: "Nachrichten synchronisiert",
            .newMessage: "Neue Nachricht",
            .newDirectMessage: "Neue Direktnachricht",
            .newCommunityMessage: "Neue Nachricht in einer Community",
            .newChannelMessage: "Neue Nachricht in einem Kanal",
            .someoneMentionedYou: "Jemand hat dich erwähnt",
            .messageRequests: "Nachrichtenanfragen",
            .newMessageRequestOne: "Du hast eine neue Nachrichtenanfrage",
            .newMessageRequestOther: "Du hast neue Nachrichtenanfragen",
            .roomTitle: "{community} / #{channel}",
            .channelTitle: "#{channel}",
        ],
        "es": [
            .reacted: "Reaccionó con {emoji} a tu mensaje",
            .repliedInThreadWith: "Respondió en un hilo: {text}",
            .repliedInThread: "Respondió en un hilo",
            .sentGif: "Envió un GIF",
            .sentImage: "Envió una imagen",
            .sentVideo: "Envió un vídeo",
            .sentVoice: "Envió un mensaje de voz",
            .sentGame: "Envió un juego",
            .sentFile: "Envió un archivo",
            .sentDirectMessage: "Te envió un mensaje directo",
            .sentMessage: "Envió un mensaje",
            .mentionedYou: "@tú {text}",
            .attributed: "{name}: {text}",
            .chat: "Chat",
            .anonymous: "Anónimo",
            .appName: "Armada",
            .messagesSynced: "Mensajes sincronizados",
            .newMessage: "Nuevo mensaje",
            .newDirectMessage: "Nuevo mensaje directo",
            .newCommunityMessage: "Nuevo mensaje en una comunidad",
            .newChannelMessage: "Nuevo mensaje en un canal",
            .someoneMentionedYou: "Alguien te ha mencionado",
            .messageRequests: "Solicitudes de mensaje",
            .newMessageRequestOne: "Tienes una nueva solicitud de mensaje",
            .newMessageRequestOther: "Tienes nuevas solicitudes de mensaje",
            .roomTitle: "{community} / #{channel}",
            .channelTitle: "#{channel}",
        ],
        "fr": [
            .reacted: "A réagi {emoji} à votre message",
            .repliedInThreadWith: "A répondu dans un fil : {text}",
            .repliedInThread: "A répondu dans un fil",
            .sentGif: "A envoyé un GIF",
            .sentImage: "A envoyé une image",
            .sentVideo: "A envoyé une vidéo",
            .sentVoice: "A envoyé un message vocal",
            .sentGame: "A envoyé un jeu",
            .sentFile: "A envoyé un fichier",
            .sentDirectMessage: "Vous a envoyé un message privé",
            .sentMessage: "A envoyé un message",
            .mentionedYou: "@vous {text}",
            .attributed: "{name} : {text}",
            .chat: "Discussion",
            .anonymous: "Anonyme",
            .appName: "Armada",
            .messagesSynced: "Messages synchronisés",
            .newMessage: "Nouveau message",
            .newDirectMessage: "Nouveau message privé",
            .newCommunityMessage: "Nouveau message dans une communauté",
            .newChannelMessage: "Nouveau message dans un salon",
            .someoneMentionedYou: "Quelqu’un vous a mentionné",
            .messageRequests: "Demandes de message",
            .newMessageRequestOne: "Vous avez une nouvelle demande de message",
            .newMessageRequestOther: "Vous avez de nouvelles demandes de message",
            .roomTitle: "{community} / #{channel}",
            .channelTitle: "#{channel}",
        ],
        "it": [
            .reacted: "Ha reagito con {emoji} al tuo messaggio",
            .repliedInThreadWith: "Ha risposto in un thread: {text}",
            .repliedInThread: "Ha risposto in un thread",
            .sentGif: "Ha inviato una GIF",
            .sentImage: "Ha inviato un’immagine",
            .sentVideo: "Ha inviato un video",
            .sentVoice: "Ha inviato un messaggio vocale",
            .sentGame: "Ha inviato un gioco",
            .sentFile: "Ha inviato un file",
            .sentDirectMessage: "Ti ha inviato un messaggio diretto",
            .sentMessage: "Ha inviato un messaggio",
            .mentionedYou: "@te {text}",
            .attributed: "{name}: {text}",
            .chat: "Chat",
            .anonymous: "Anonimo",
            .appName: "Armada",
            .messagesSynced: "Messaggi sincronizzati",
            .newMessage: "Nuovo messaggio",
            .newDirectMessage: "Nuovo messaggio diretto",
            .newCommunityMessage: "Nuovo messaggio in una community",
            .newChannelMessage: "Nuovo messaggio in un canale",
            .someoneMentionedYou: "Qualcuno ti ha menzionato",
            .messageRequests: "Richieste di messaggio",
            .newMessageRequestOne: "Hai una nuova richiesta di messaggio",
            .newMessageRequestOther: "Hai nuove richieste di messaggio",
            .roomTitle: "{community} / #{channel}",
            .channelTitle: "#{channel}",
        ],
        "nl": [
            .reacted: "Reageerde met {emoji} op je bericht",
            .repliedInThreadWith: "Antwoordde in een thread: {text}",
            .repliedInThread: "Antwoordde in een thread",
            .sentGif: "Stuurde een gif",
            .sentImage: "Stuurde een afbeelding",
            .sentVideo: "Stuurde een video",
            .sentVoice: "Stuurde een spraakbericht",
            .sentGame: "Stuurde een game",
            .sentFile: "Stuurde een bestand",
            .sentDirectMessage: "Stuurde je een privébericht",
            .sentMessage: "Stuurde een bericht",
            .mentionedYou: "@jij {text}",
            .attributed: "{name}: {text}",
            .chat: "Chat",
            .anonymous: "Anoniem",
            .appName: "Armada",
            .messagesSynced: "Berichten gesynchroniseerd",
            .newMessage: "Nieuw bericht",
            .newDirectMessage: "Nieuw privébericht",
            .newCommunityMessage: "Nieuw bericht in een community",
            .newChannelMessage: "Nieuw bericht in een kanaal",
            .someoneMentionedYou: "Iemand heeft je genoemd",
            .messageRequests: "Berichtverzoeken",
            .newMessageRequestOne: "Je hebt een nieuw berichtverzoek",
            .newMessageRequestOther: "Je hebt nieuwe berichtverzoeken",
            .roomTitle: "{community} / #{channel}",
            .channelTitle: "#{channel}",
        ],
        "pt": [
            .reacted: "Reagiu com {emoji} à sua mensagem",
            .repliedInThreadWith: "Respondeu na thread: {text}",
            .repliedInThread: "Respondeu na thread",
            .sentGif: "Enviou um GIF",
            .sentImage: "Enviou uma imagem",
            .sentVideo: "Enviou um vídeo",
            .sentVoice: "Enviou uma mensagem de voz",
            .sentGame: "Enviou um jogo",
            .sentFile: "Enviou um arquivo",
            .sentDirectMessage: "Enviou uma mensagem direta para você",
            .sentMessage: "Enviou uma mensagem",
            .mentionedYou: "@você {text}",
            .attributed: "{name}: {text}",
            .chat: "Chat",
            .anonymous: "Anônimo",
            .appName: "Armada",
            .messagesSynced: "Mensagens sincronizadas",
            .newMessage: "Nova mensagem",
            .newDirectMessage: "Nova mensagem direta",
            .newCommunityMessage: "Nova mensagem em uma comunidade",
            .newChannelMessage: "Nova mensagem em um canal",
            .someoneMentionedYou: "Alguém mencionou você",
            .messageRequests: "Solicitações de mensagem",
            .newMessageRequestOne: "Você tem uma nova solicitação de mensagem",
            .newMessageRequestOther: "Você tem novas solicitações de mensagem",
            .roomTitle: "{community} / #{channel}",
            .channelTitle: "#{channel}",
        ],
        "ja": [
            .reacted: "あなたのメッセージに {emoji} でリアクションしました",
            .repliedInThreadWith: "スレッドで返信しました: {text}",
            .repliedInThread: "スレッドで返信しました",
            .sentGif: "GIF を送信しました",
            .sentImage: "画像を送信しました",
            .sentVideo: "動画を送信しました",
            .sentVoice: "ボイスメッセージを送信しました",
            .sentGame: "ゲームを送信しました",
            .sentFile: "ファイルを送信しました",
            .sentDirectMessage: "ダイレクトメッセージを送信しました",
            .sentMessage: "メッセージを送信しました",
            .mentionedYou: "@あなた {text}",
            .attributed: "{name}: {text}",
            .chat: "チャット",
            .anonymous: "匿名",
            .appName: "Armada",
            .messagesSynced: "メッセージを同期しました",
            .newMessage: "新しいメッセージ",
            .newDirectMessage: "新しいダイレクトメッセージ",
            .newCommunityMessage: "コミュニティに新しいメッセージ",
            .newChannelMessage: "チャンネルに新しいメッセージ",
            .someoneMentionedYou: "誰かがあなたをメンションしました",
            .messageRequests: "メッセージリクエスト",
            .newMessageRequestOne: "新しいメッセージリクエストがあります",
            .newMessageRequestOther: "新しいメッセージリクエストがあります",
            .roomTitle: "{community} / #{channel}",
            .channelTitle: "#{channel}",
        ],
    ]
}

import Foundation

/// Whether a push that arrives while Armada is open is about the room already
/// on screen.
///
/// The extension writes the room's route into the notification as `url`, and
/// the page reports the route it is showing, so the two compare as routes. A
/// message path names its room plus `/m/<id>`; everything up to that is the
/// room. A thread (`/t/<root>`) is its own view, so a channel message is not
/// "on screen" while a thread in that channel is.
public enum ForegroundPresentation {

    public static func isShowing(path: String, activeRoute: String?) -> Bool {
        guard let activeRoute else { return false }
        return room(path) == room(activeRoute)
    }

    static func room(_ path: String) -> String {
        var segments = path.split(separator: "/", omittingEmptySubsequences: true)
            .map { String($0).removingPercentEncoding ?? String($0) }
        // Only a trailing `m/<id>`, so a room whose own id is "m" is kept.
        if segments.count >= 4, segments[segments.count - 2] == "m" {
            segments.removeLast(2)
        }
        return "/" + segments.joined(separator: "/")
    }
}

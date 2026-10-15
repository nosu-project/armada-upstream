import XCTest

@testable import ArmadaNotify

final class ForegroundPresentationTests: XCTestCase {

    func testAMessageInTheOpenRoomIsOnScreen() {
        XCTAssertTrue(ForegroundPresentation.isShowing(path: "/c/cc/dd/m/ee", activeRoute: "/c/cc/dd"))
        XCTAssertTrue(ForegroundPresentation.isShowing(path: "/c/cc/dd/m/ee", activeRoute: "/c/cc/dd/m/ff"))
        XCTAssertTrue(ForegroundPresentation.isShowing(path: "/dm/npub1a", activeRoute: "/dm/npub1a/m/x"))
        XCTAssertTrue(ForegroundPresentation.isShowing(
            path: "/s/relay.example/general/m/ee", activeRoute: "/s/relay.example/general/"
        ))
    }

    func testOtherRoomsAreNot() {
        XCTAssertFalse(ForegroundPresentation.isShowing(path: "/c/cc/dd/m/ee", activeRoute: "/c/cc/zz"))
        XCTAssertFalse(ForegroundPresentation.isShowing(path: "/dm/npub1a", activeRoute: "/dm/npub1b"))
        XCTAssertFalse(ForegroundPresentation.isShowing(path: "/dm/npub1a", activeRoute: "/dm"))
        XCTAssertFalse(
            ForegroundPresentation.isShowing(path: "/c/cc/dd/m/ee", activeRoute: "/c/cc/dd/t/root"),
            "a thread is its own view"
        )
        XCTAssertFalse(ForegroundPresentation.isShowing(path: "/c/cc/dd/m/ee", activeRoute: nil))
    }

    func testEscapingDoesNotMatter() {
        XCTAssertTrue(ForegroundPresentation.isShowing(
            path: "/s/relay.example/a%20b/m/ee", activeRoute: "/s/relay.example/a b"
        ))
    }

    func testARoomCalledMIsStillARoom() {
        XCTAssertFalse(ForegroundPresentation.isShowing(path: "/c/cc/m", activeRoute: "/c/cc"))
    }
}

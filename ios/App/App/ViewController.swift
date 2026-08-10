import Capacitor
import UIKit

/// The app's Capacitor view controller, which exists for one reason: to
/// register the app-local plugins (`ArmadaDbPlugin`, `ArmadaPushPlugin`).
///
/// Capacitor's automatic registration walks `packageClassList` in
/// `capacitor.config.json`, which `cap sync` regenerates from the installed npm
/// plugin packages — so a plugin that lives in the app target rather than in a
/// package can't be listed there without the next sync dropping it.
/// `registerPluginInstance` is the supported path for exactly that case, and
/// `capacitorDidLoad()` is the moment the bridge exists but the web view has
/// not yet loaded.
///
/// Android registers the equivalent in `MainActivity.java`.
class ViewController: CAPBridgeViewController {

    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(ArmadaDbPlugin())
        bridge?.registerPluginInstance(ArmadaPushPlugin())
    }
}

import UIKit
import Capacitor

/// Bridge view controller that registers the app's own plugins.
class LpuBridgeViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(LpuTrustPlugin())
    }
}

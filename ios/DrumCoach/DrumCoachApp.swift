import SwiftUI

@main
struct DrumCoachApp: App {
    var body: some Scene {
        WindowGroup {
            ZStack {
                // Same colour as the page, so the status bar area does not show a seam.
                Color("PageBackground").ignoresSafeArea()
                WebView().ignoresSafeArea(.keyboard)
            }
            // The player's hands are on the drums, not the screen: never dim or lock while the app is open.
            .onAppear { UIApplication.shared.isIdleTimerDisabled = true }
        }
    }
}

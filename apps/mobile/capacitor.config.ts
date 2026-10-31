import type { CapacitorConfig } from "@capacitor/cli";
import { KeyboardResize } from "@capacitor/keyboard";
import { SystemBarsStyle } from "@capacitor-community/safe-area";

const config: CapacitorConfig = {
  appId: "com.polyth.mobile",
  appName: "Polyth",
  webDir: "../web/dist",
  backgroundColor: "#07091c",
  ios: {
    // The web bundle owns safe-area spacing through viewport-fit=cover and
    // --safe-* tokens. Never let WKWebView add a second native top inset:
    // that native gutter prevents the selected workspace background from
    // painting behind the status bar / Dynamic Island.
    contentInset: "never",
  },
  server: {
    hostname: "localhost",
    androidScheme: "https",
    iosScheme: "capacitor",
    // The authenticated Rust proxy is the only non-bundled WebView destination.
    // PolythLink native methods additionally reject calls after leaving the
    // bundled capacitor://localhost / https://localhost origin.
    allowNavigation: ["127.0.0.1"],
  },
  plugins: {
    App: {
      // Keep AndroidX's dispatcher active. Polyth's single JS listener owns
      // completed Back events and suppresses Capacitor's default navigation.
      disableBackButtonHandler: false,
    },
    CapacitorHttp: {
      // Capacitor injects its bridge into every WebView document, the Link
      // loopback shell included, and when enabled routes non-GET fetch/XHR
      // through native HTTP whose cookie jar is not WKWebView's. The proxy
      // session cookie claimed by POST then never reaches the shell (401).
      // Explicit CapacitorHttp.get() calls keep working without the patch.
      enabled: false,
    },
    Keyboard: {
      resize: KeyboardResize.Native,
      resizeOnFullScreen: false,
    },
    SplashScreen: {
      // The launch screen (a centred 112pt/dp mark on the brand
      // night, see scripts/generate-assets.mjs) hands over to the page's
      // identical launch veil once the page is up (src/launch.ts). The auto
      // hide is only the safety net for a page that never gets that far.
      launchAutoHide: true,
      launchShowDuration: 10_000,
      backgroundColor: "#07091c",
      showSpinner: false,
      // The legacy (pre-Android 12 API) splash uses the same layered picture.
      androidSplashResourceName: "polyth_launch",
    },
    // @capacitor-community/safe-area owns edge-to-edge inset handling. Keep
    // Capacitor 8's parallel Android SystemBars inset shim disabled so the two
    // systems cannot both consume the same safe area.
    SystemBars: {
      insetsHandling: "disable",
    },
    SafeArea: {
      statusBarStyle: SystemBarsStyle.Default,
      navigationBarStyle: SystemBarsStyle.Default,
      initialViewportFitCover: true,
    },
    LocalNotifications: {
      smallIcon: "ic_stat_polyth",
      iconColor: "#6f6bff",
    },
  },
};

export default config;

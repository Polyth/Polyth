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
      enabled: true,
    },
    Keyboard: {
      resize: KeyboardResize.Native,
      resizeOnFullScreen: false,
    },
    SplashScreen: {
      launchAutoHide: false,
      backgroundColor: "#07091c",
      showSpinner: false,
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

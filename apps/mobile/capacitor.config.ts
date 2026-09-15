import type { CapacitorConfig } from "@capacitor/cli";
import { KeyboardResize } from "@capacitor/keyboard";
import { SystemBarsStyle } from "@capacitor-community/safe-area";

const config: CapacitorConfig = {
  appId: "com.polyth.mobile",
  appName: "Polyth",
  webDir: "../web/dist",
  backgroundColor: "#07091c",
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

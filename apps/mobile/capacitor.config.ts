import type { CapacitorConfig } from "@capacitor/cli";
import { KeyboardResize } from "@capacitor/keyboard";
import { SystemBarsStyle } from "@capacitor-community/safe-area";

const config: CapacitorConfig = {
  appId: "com.polyth.mobile",
  appName: "Polyth",
  webDir: "../web/dist",
  backgroundColor: "#1b1713",
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
      disableBackButtonHandler: true,
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
      backgroundColor: "#1b1713",
      showSpinner: false,
    },
    SafeArea: {
      statusBarStyle: SystemBarsStyle.Default,
      navigationBarStyle: SystemBarsStyle.Default,
      initialViewportFitCover: true,
    },
    LocalNotifications: {
      smallIcon: "ic_stat_polyth",
      iconColor: "#f49b5b",
    },
  },
};

export default config;

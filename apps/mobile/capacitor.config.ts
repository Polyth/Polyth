import type { CapacitorConfig } from "@capacitor/cli";
import { KeyboardResize } from "@capacitor/keyboard";
import { SystemBarsStyle } from "@capacitor-community/safe-area";

const config: CapacitorConfig = {
  appId: "com.polyth.mobile",
  appName: "Polyth",
  webDir: "../web/dist",
  backgroundColor: "#1b1713",
  // The bundled first-launch shell validates one user-entered Polyth host and
  // then loads that host as the canonical same-origin app. Runtime navigation
  // policy in src/nativeBridge.ts keeps all other HTTP(S) links in the platform
  // browser.
  server: {
    hostname: "localhost",
    androidScheme: "https",
    iosScheme: "capacitor",
    allowNavigation: ["*"],
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

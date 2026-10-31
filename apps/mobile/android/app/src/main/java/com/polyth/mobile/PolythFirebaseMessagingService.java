package com.polyth.mobile;

import androidx.annotation.NonNull;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

/** FCM lifecycle stays native; the WebView never receives the provider token. */
public final class PolythFirebaseMessagingService extends FirebaseMessagingService {
    @Override public void onNewToken(@NonNull String token) {
        super.onNewToken(token);
        PolythPushPlugin.onProviderToken(getApplicationContext(), token);
    }

    @Override public void onMessageReceived(@NonNull RemoteMessage message) {
        PolythPushPlugin.receiveMessage(getApplicationContext(), message.getData());
    }
}

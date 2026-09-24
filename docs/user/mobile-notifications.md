# Mobile notifications

Receive alerts when an agent finishes, fails, needs approval, or asks for input. Tap a notification to open its thread. Use T3 Connect or configure your environment to send notifications with your own Apple or Firebase credentials.

## Use T3 Connect

Sign in to T3 Connect, link your environments, and enable **Device Notifications** in Settings. Your environment must have agent activity publishing enabled.

Enable **Ongoing Agent Activity** on Android or **Live Activity Updates** on iOS to follow work without opening the app. Finished results remain visible for up to 15 minutes. You can dismiss an Android activity card without disabling alerts; turn off ongoing activity in Settings to stop future cards.

Ordinary alerts stay quiet while the mobile app is in the foreground. Ongoing activity continues to update. Viewing a thread on another device does not silence your phone's alerts.

Android notifications require Android 7.0 or newer and Google Play services. Android 16 and newer can promote ongoing activity to a Live Update, subject to system settings and device support. Other devices show a regular ongoing notification. Android 7's battery-saving modes can delay removal of expired cards.

Notification permission and Android notification channels are controlled in system Settings. Background delivery requires T3 Connect or a self-hosted push sender configured as described below. A direct or Tailscale connection alone does not enable push notifications. The mobile app does not need to maintain a connection to your environment. Force-stopping the Android app in system Settings prevents push delivery until you open it again.

## Use your own push credentials

Self-hosted notifications require your own mobile build. Credentials for your Apple app or Firebase project cannot send notifications to the official T3 Code app. Your environment must stay running and have outbound internet access to Apple or Google. Your phone does not need to keep its connection to the environment open.

Self-hosted delivery supports alerts. Live Activities and ongoing agent activity still require T3 Connect.

### Configure Apple delivery

Use a paid Apple Developer account with Push Notifications enabled for your app identifier. Free Personal Team builds cannot receive remote notifications.

1. Create an APNs signing key and save its `.p8` file on the machine running your environment.
2. Set these environment variables before starting the T3 server:

   ```sh
   export T3CODE_PUSH_APNS_KEY_FILE=/absolute/path/AuthKey.p8
   export T3CODE_PUSH_APNS_KEY_ID=YOUR_KEY_ID
   export T3CODE_PUSH_APNS_TEAM_ID=YOUR_TEAM_ID
   export T3CODE_PUSH_APNS_BUNDLE_ID=com.example.t3code
   export T3CODE_PUSH_APNS_ENVIRONMENT=production
   ```

3. Use `sandbox` for an app signed with development provisioning. Use `production` for TestFlight or distribution provisioning.
4. Build and install the iOS app with `T3CODE_IOS_BUNDLE_ID` matching the server's bundle identifier and `T3CODE_IOS_APPLE_TEAM_ID` matching your developer team. Set `T3CODE_MOBILE_UPDATES_ENABLED=0` for your private build.

Keep the signing key on the server. Do not include it in the mobile app.

### Configure Android delivery

1. Register your app's package identifier in your Firebase project and download its `google-services.json`.
2. Create a service-account key with permission to send Firebase Cloud Messaging messages and enable the FCM API for that project.
3. Save the service-account JSON on the machine running your environment. Set `T3CODE_PUSH_FCM_SERVICE_ACCOUNT_FILE` to its absolute path before starting the T3 server.
4. Build and install the Android app with `T3CODE_ANDROID_PACKAGE` set to your package identifier and `T3CODE_ANDROID_GOOGLE_SERVICES_FILE` set to the path of `google-services.json`. Set `T3CODE_MOBILE_UPDATES_ENABLED=0` for your private build.

The Firebase app configuration belongs in the mobile build. The private service-account key belongs only on the server.

### Enable alerts on your phone

Restart your environment after configuring its push credentials. Pair your private mobile build with the environment using a direct or Tailscale connection, then enable **Self-Hosted Notifications** in Settings and allow notification permission. No T3 Connect sign-in is required.

This setting replaces T3 Connect alerts on your phone. Only directly paired environments configured for your phone's platform can send self-hosted alerts. Live Activities keep their existing T3 Connect settings.

Turn off **Self-Hosted Notifications** to unregister the phone and restore T3 Connect alerts if you use Connect. Keep the environment reachable until unregistration succeeds. Revoking the phone's paired session on the environment also stops its self-hosted notifications.

To verify delivery, start an agent turn and lock the phone before it finishes. Tap the completion alert to open the thread. If an alert does not arrive, check notification permission, the registration status in Settings, and the server's push-delivery logs. An iOS token must match the configured APNs sandbox or production environment. An Android token must belong to the configured Firebase project.

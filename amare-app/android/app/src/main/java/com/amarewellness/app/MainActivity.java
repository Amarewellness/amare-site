package com.amarewellness.app;

import android.os.Bundle;
import androidx.core.splashscreen.SplashScreen;
import com.getcapacitor.BridgeActivity;
import com.stripe.android.paymentsheet.PaymentSheet;
import com.stripe.android.paymentsheet.PaymentSheetResult;
import com.stripe.android.paymentsheet.PaymentSheetResultCallback;

public class MainActivity extends BridgeActivity {
    private PaymentSheet paymentSheet;
    private PaymentSheetResultCallback pendingCallback;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        SplashScreen.installSplashScreen(this);
        registerPlugin(AmareSettingsPlugin.class);
        registerPlugin(AmareStripePaymentPlugin.class);
        super.onCreate(savedInstanceState);
        paymentSheet = new PaymentSheet.Builder(this::onPaymentSheetResult).build(this);
    }

    public void presentAmarePaymentSheet(
            String clientSecret,
            PaymentSheet.Configuration configuration,
            PaymentSheetResultCallback callback
    ) {
        pendingCallback = callback;
        paymentSheet.presentWithPaymentIntent(clientSecret, configuration);
    }

    private void onPaymentSheetResult(PaymentSheetResult result) {
        PaymentSheetResultCallback callback = pendingCallback;
        pendingCallback = null;
        if (callback != null) {
            callback.onPaymentSheetResult(result);
        }
    }
}

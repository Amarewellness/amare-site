package com.amarewellness.app;

import android.util.Log;
import androidx.annotation.NonNull;

import java.util.Arrays;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.stripe.android.PaymentConfiguration;
import com.stripe.android.paymentsheet.PaymentSheet;
import com.stripe.android.paymentsheet.PaymentSheetResult;

@CapacitorPlugin(name = "AmareStripePayment")
public class AmareStripePaymentPlugin extends Plugin {
    private PluginCall pendingCall;

    @PluginMethod
    public void presentPaymentSheet(PluginCall call) {
        String publishableKey = call.getString("publishableKey", "");
        String clientSecret = call.getString("clientSecret", "");
        String merchantDisplayName = call.getString("merchantDisplayName", "AMARÉ");

        if (publishableKey == null || !publishableKey.startsWith("pk_")) {
            call.reject("missing_publishable_key");
            return;
        }
        if (clientSecret == null || clientSecret.isEmpty()) {
            call.reject("missing_client_secret");
            return;
        }
        if (!(getActivity() instanceof MainActivity)) {
            call.reject("payment_sheet_unavailable");
            return;
        }
        if (pendingCall != null) {
            Log.d("AmareStripe", "payment_sheet_busy ignored");
            JSObject ignored = new JSObject();
            ignored.put("status", "ignored");
            call.resolve(ignored);
            return;
        }

        MainActivity activity = (MainActivity) getActivity();
        PaymentConfiguration.init(getContext(), publishableKey);

        PaymentSheet.GooglePayConfiguration googlePay =
                new PaymentSheet.GooglePayConfiguration(
                        PaymentSheet.GooglePayConfiguration.Environment.Test,
                        "US",
                        "USD");
        PaymentSheet.Configuration configuration =
                new PaymentSheet.Configuration.Builder(merchantDisplayName)
                        .googlePay(googlePay)
                        .allowsDelayedPaymentMethods(false)
                        .link(new PaymentSheet.LinkConfiguration(PaymentSheet.LinkConfiguration.Display.Never))
                        .paymentMethodOrder(Arrays.asList("card", "google_pay"))
                        .build();

        pendingCall = call;
        call.setKeepAlive(true);

        activity.runOnUiThread(() ->
                activity.presentAmarePaymentSheet(clientSecret, configuration, this::onSheetResult)
        );
    }

    private void onSheetResult(@NonNull PaymentSheetResult result) {
        PluginCall call = pendingCall;
        pendingCall = null;
        if (call == null) return;

        JSObject ret = new JSObject();
        if (result instanceof PaymentSheetResult.Completed) {
            ret.put("status", "completed");
            call.resolve(ret);
            return;
        }
        if (result instanceof PaymentSheetResult.Canceled) {
            ret.put("status", "canceled");
            call.resolve(ret);
            return;
        }
        if (result instanceof PaymentSheetResult.Failed) {
            PaymentSheetResult.Failed failed = (PaymentSheetResult.Failed) result;
            ret.put("status", "failed");
            String message = failed.getError() != null ? failed.getError().getLocalizedMessage() : "payment_failed";
            ret.put("message", message == null ? "payment_failed" : message);
            call.resolve(ret);
            return;
        }
        ret.put("status", "failed");
        ret.put("message", "unknown_payment_sheet_result");
        call.resolve(ret);
    }
}

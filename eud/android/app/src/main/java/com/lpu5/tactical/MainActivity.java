package com.lpu5.tactical;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(LpuTrustPlugin.class);
        super.onCreate(savedInstanceState);
        // Accept certificates from LPU5 servers whose CA the user pinned.
        bridge.setWebViewClient(new TrustingWebViewClient(bridge));
    }
}

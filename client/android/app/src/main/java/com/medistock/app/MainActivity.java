package com.medistock.app;

import android.os.Bundle;
import android.view.View;
import android.view.WindowInsets;
import android.view.ViewGroup;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        
        // Handle system insets for status bar and navigation bar
        getWindow().getDecorView().setOnApplyWindowInsetsListener((v, insets) -> {
            // Get the root view of the activity
            View rootView = ((ViewGroup) findViewById(android.R.id.content)).getChildAt(0);
            
            // Apply padding to avoid status bar overlap
            if (rootView != null) {
                rootView.setPadding(
                    rootView.getPaddingLeft(),
                    rootView.getPaddingTop() + insets.getSystemWindowInsetTop(),
                    rootView.getPaddingRight(),
                    rootView.getPaddingBottom() + insets.getSystemWindowInsetBottom()
                );
            }
            
            return insets.consumeSystemWindowInsets();
        });
    }
}
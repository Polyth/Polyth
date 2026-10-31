package com.polyth.mobile;

import android.app.Activity;
import android.content.res.ColorStateList;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Rect;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.HapticFeedbackConstants;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.animation.AccelerateInterpolator;
import android.view.animation.PathInterpolator;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.PopupWindow;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.List;

/**
 * The server menu the open server's page asks for at its server button. It is
 * drawn natively, not in the page: the page is that server's content and never
 * sees the other paired servers. The panel scales out of the button, any touch
 * outside closes it, Back closes it.
 */
final class PolythServerMenu {
    static final class Item {
        final String id;
        final String title;
        final String detail;
        final boolean current;
        final boolean enabled;
        /** Status dot: "connected", "ready", "warning" or "danger". */
        final String tone;

        Item(String id, String title, String detail, boolean current, boolean enabled, String tone) {
            this.id = id;
            this.title = title;
            this.detail = detail;
            this.current = current;
            this.enabled = enabled;
            this.tone = tone;
        }
    }

    interface Listener {
        /** `connectionId` for a server, "add" for Add server, null when dismissed. */
        void onChoice(String kind, String connectionId);
    }

    private static final float OPEN_SCALE = 0.78f;

    private final Activity activity;
    private final View host;
    private final Listener listener;
    private final boolean night;
    private final int accent;
    private final int ink;
    private final int quietInk;
    private PopupWindow popup;
    private View panel;
    private boolean finished;

    PolythServerMenu(Activity activity, View host, Listener listener) {
        this.activity = activity;
        this.host = host;
        this.listener = listener;
        int mode = activity.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
        night = mode == Configuration.UI_MODE_NIGHT_YES;
        accent = night ? 0xFF8E8BFF : 0xFF5E5AF0;
        ink = night ? 0xFFF2F2F5 : 0xFF17171C;
        quietInk = night ? 0x99EBEBF5 : 0x993C3C43;
    }

    private int dp(float value) {
        return Math.round(TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP, value, activity.getResources().getDisplayMetrics()));
    }

    /** `anchor` is the button in CSS pixels of the web view's viewport. */
    void show(List<Item> items, float x, float y, float width, float height) {
        float density = activity.getResources().getDisplayMetrics().density;
        int[] origin = new int[2];
        host.getLocationInWindow(origin);
        Rect button = new Rect(
            origin[0] + Math.round(x * density),
            origin[1] + Math.round(y * density),
            origin[0] + Math.round((x + width) * density),
            origin[1] + Math.round((y + height) * density)
        );
        Rect visible = new Rect();
        host.getWindowVisibleDisplayFrame(visible);
        int[] windowOnScreen = new int[2];
        host.getRootView().getLocationOnScreen(windowOnScreen);
        visible.offset(-windowOnScreen[0], -windowOnScreen[1]);

        LinearLayout list = new LinearLayout(activity);
        list.setOrientation(LinearLayout.VERTICAL);
        list.addView(header());
        for (int i = 0; i < items.size(); i++) {
            if (i > 0) list.addView(hairline());
            list.addView(serverRow(items.get(i)));
        }
        if (!items.isEmpty()) list.addView(sectionGap());
        list.addView(addRow());

        ScrollView scroll = new ScrollView(activity);
        scroll.setVerticalScrollBarEnabled(false);
        scroll.setOverScrollMode(View.OVER_SCROLL_NEVER);
        scroll.addView(list, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        GradientDrawable surface = new GradientDrawable();
        surface.setColor(night ? 0xF22A2A30 : 0xF7FFFFFF);
        surface.setCornerRadius(dp(16));
        surface.setStroke(Math.max(1, dp(0.5f)), night ? 0x1FFFFFFF : 0x14000000);
        scroll.setBackground(surface);
        scroll.setClipToOutline(true);
        scroll.setElevation(dp(14));
        panel = scroll;

        // Room for the shadow around the panel inside the popup window.
        int shadow = dp(20);
        FrameLayout frame = new FrameLayout(activity);
        frame.setClipChildren(false);
        frame.setClipToPadding(false);
        frame.setPadding(shadow, shadow, shadow, shadow);
        frame.addView(scroll, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        int margin = dp(12);
        int gap = dp(8);
        int panelWidth = Math.min(dp(300), visible.width() - margin * 2);
        list.measure(
            View.MeasureSpec.makeMeasureSpec(panelWidth, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED)
        );
        int content = list.getMeasuredHeight();
        int spaceBelow = visible.bottom - margin - (button.bottom + gap);
        int spaceAbove = button.top - gap - (visible.top + margin);
        boolean below = content <= spaceBelow || spaceBelow >= spaceAbove;
        int panelHeight = Math.min(content, Math.max(dp(120), below ? spaceBelow : spaceAbove));
        int top = below ? button.bottom + gap : button.top - gap - panelHeight;
        // Hang off the button's outer edge: right-hand buttons open leftwards.
        int preferredLeft = button.centerX() > visible.centerX() ? button.right - panelWidth : button.left;
        int left = Math.min(Math.max(preferredLeft, visible.left + margin), visible.right - margin - panelWidth);

        scroll.setLayoutParams(new FrameLayout.LayoutParams(panelWidth, panelHeight));
        popup = new PopupWindow(frame, panelWidth + shadow * 2, panelHeight + shadow * 2, true);
        popup.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
        popup.setAnimationStyle(0);
        popup.setOutsideTouchable(true);
        popup.setClippingEnabled(false);
        popup.setTouchInterceptor((view, event) -> {
            // Outside touches close through the same quick exit as a choice.
            if (event.getAction() == MotionEvent.ACTION_OUTSIDE || (event.getAction() == MotionEvent.ACTION_DOWN
                && !insidePanel(event))) {
                finish(null, null);
                return true;
            }
            return false;
        });
        popup.setOnDismissListener(() -> {
            // Back, or the system closing the window.
            if (finished) return;
            finished = true;
            listener.onChoice(null, null);
        });

        // Scale out of the button: pivot on the panel corner nearest to it.
        scroll.setPivotX(Math.max(0, Math.min(panelWidth, button.centerX() - left)));
        scroll.setPivotY(below ? 0 : panelHeight);
        scroll.setAlpha(0f);
        scroll.setScaleX(OPEN_SCALE);
        scroll.setScaleY(OPEN_SCALE);
        popup.showAtLocation(host, Gravity.TOP | Gravity.LEFT, left - shadow, top - shadow);
        scroll.animate()
            .scaleX(1f)
            .scaleY(1f)
            .setDuration(240)
            .setInterpolator(new PathInterpolator(0.16f, 1f, 0.3f, 1f))
            .start();
        scroll.animate().alpha(1f).setDuration(110).start();
        for (int i = 0; i < list.getChildCount(); i++) {
            View row = list.getChildAt(i);
            row.setAlpha(0f);
            row.setTranslationY(dp(below ? -5 : 5));
            row.animate()
                .alpha(1f)
                .translationY(0f)
                .setStartDelay(30L + Math.min(i, 8) * 14L)
                .setDuration(200)
                .setInterpolator(new PathInterpolator(0.2f, 0f, 0f, 1f))
                .start();
        }
    }

    private boolean insidePanel(MotionEvent event) {
        if (panel == null) return false;
        float x = event.getX() - panel.getLeft();
        float y = event.getY() - panel.getTop();
        return x >= 0 && y >= 0 && x < panel.getWidth() && y < panel.getHeight();
    }

    /** Close fast (the choice is already made), then report it. */
    void finish(String kind, String connectionId) {
        if (finished || popup == null) return;
        finished = true;
        if (kind != null) host.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY);
        Runnable close = () -> {
            if (popup.isShowing()) popup.dismiss();
            listener.onChoice(kind, connectionId);
        };
        if (panel == null) { close.run(); return; }
        panel.animate().cancel();
        panel.animate()
            .alpha(0f)
            .scaleX(0.95f)
            .scaleY(0.95f)
            .setStartDelay(0)
            .setDuration(130)
            .setInterpolator(new AccelerateInterpolator(1.5f))
            .withEndAction(close)
            .start();
    }

    /** Close at once (the page went away). */
    void dismissNow() {
        if (finished || popup == null) return;
        finished = true;
        if (popup.isShowing()) popup.dismiss();
        listener.onChoice(null, null);
    }

    private TextView header() {
        TextView label = new TextView(activity);
        label.setText("Servers");
        label.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        label.setTextColor(quietInk);
        label.setPadding(dp(16), dp(12), dp(16), dp(4));
        if (android.os.Build.VERSION.SDK_INT >= 28) label.setAccessibilityHeading(true);
        return label;
    }

    private View hairline() {
        View line = new View(activity);
        line.setBackgroundColor(night ? 0x24FFFFFF : 0x1F000000);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, Math.max(1, dp(0.5f)));
        params.setMarginStart(dp(42));
        line.setLayoutParams(params);
        return line;
    }

    private View sectionGap() {
        View band = new View(activity);
        band.setBackgroundColor(night ? 0x0FFFFFFF : 0x0A000000);
        band.setLayoutParams(new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(8)));
        return band;
    }

    private View serverRow(Item item) {
        View dot = new View(activity);
        GradientDrawable circle = new GradientDrawable();
        circle.setShape(GradientDrawable.OVAL);
        circle.setColor(toneColor(item.tone));
        dot.setBackground(circle);
        LinearLayout.LayoutParams dotParams = new LinearLayout.LayoutParams(dp(8), dp(8));
        dotParams.setMarginStart(dp(4));
        dotParams.setMarginEnd(dp(16));
        dot.setLayoutParams(dotParams);

        LinearLayout row = row(item.title, item.detail, false, item.current);
        row.addView(dot, 0);
        row.setEnabled(item.enabled);
        row.setAlpha(item.enabled ? 1f : 0.38f);
        row.setSelected(item.current);
        row.setContentDescription(item.title + ", " + item.detail);
        if (item.enabled) row.setOnClickListener(view -> finish("server", item.id));
        return row;
    }

    private View addRow() {
        TextView plus = new TextView(activity);
        plus.setText("+");
        plus.setTextSize(TypedValue.COMPLEX_UNIT_SP, 22);
        plus.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        plus.setTextColor(accent);
        plus.setGravity(Gravity.CENTER);
        plus.setIncludeFontPadding(false);
        LinearLayout.LayoutParams plusParams = new LinearLayout.LayoutParams(dp(16), ViewGroup.LayoutParams.WRAP_CONTENT);
        plusParams.setMarginEnd(dp(12));
        plus.setLayoutParams(plusParams);

        LinearLayout row = row("Add server", "Scan a QR code or pair nearby", true, false);
        row.addView(plus, 0);
        row.setContentDescription("Add server, scan a QR code or pair nearby");
        row.setOnClickListener(view -> finish("add", null));
        return row;
    }

    private LinearLayout row(String title, String detail, boolean accented, boolean checked) {
        LinearLayout row = new LinearLayout(activity);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setMinimumHeight(dp(52));
        row.setPadding(dp(14), dp(10), dp(16), dp(10));
        row.setClickable(true);
        row.setFocusable(true);
        row.setBackground(new RippleDrawable(
            ColorStateList.valueOf(night ? 0x2EFFFFFF : 0x1F000000),
            null,
            new ColorDrawable(Color.WHITE)
        ));

        LinearLayout copy = new LinearLayout(activity);
        copy.setOrientation(LinearLayout.VERTICAL);
        TextView titleView = new TextView(activity);
        titleView.setText(title);
        titleView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        titleView.setTextColor(accented ? accent : ink);
        titleView.setSingleLine(true);
        titleView.setEllipsize(TextUtils.TruncateAt.END);
        copy.addView(titleView);
        TextView detailView = new TextView(activity);
        detailView.setText(detail);
        detailView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        detailView.setTextColor(quietInk);
        detailView.setSingleLine(true);
        detailView.setEllipsize(TextUtils.TruncateAt.END);
        copy.addView(detailView);
        row.addView(copy, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        if (checked) {
            TextView check = new TextView(activity);
            check.setText("✓");
            check.setTextSize(TypedValue.COMPLEX_UNIT_SP, 17);
            check.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
            check.setTextColor(accent);
            check.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
            LinearLayout.LayoutParams checkParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            checkParams.setMarginStart(dp(12));
            row.addView(check, checkParams);
        }
        return row;
    }

    private int toneColor(String tone) {
        switch (tone) {
            case "connected": return 0xFF34C759;
            case "warning": return 0xFFFF9F0A;
            case "danger": return 0xFFFF453A;
            default: return night ? 0x66EBEBF5 : 0x553C3C43;
        }
    }
}

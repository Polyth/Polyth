import ActivityKit
import SwiftUI
import WidgetKit

/// Renders Polyth's Live Activity: the chat that needs a person (a question or
/// an approval) or the one that is working, in the Dynamic Island and on the
/// Lock Screen. Content arrives localized from the web shell through
/// `PolythLiveActivityPlugin`; this extension only lays it out. Chat text is
/// `privacySensitive`, so the system can redact it on a locked device.
@main
struct PolythLiveActivityBundle: WidgetBundle {
    var body: some Widget {
        PolythLiveActivityWidget()
    }
}

private typealias State = PolythActivityAttributes.ContentState

/// The tap opens the chat only in the page that published it; other pages
/// ignore the URL and the app simply comes to the foreground.
private func openURL(_ state: State) -> URL? {
    var parts = URLComponents()
    parts.scheme = "polyth"
    parts.host = "live-activity"
    parts.path = "/" + state.sessionId
    return parts.url
}

/// Polyth's mark, simplified from the app icon for 20-30 pt: a hexagonal
/// ribbon with rounded corners whose lower-left edge runs on as a tail, passing
/// in front of the start of the right strand with a thin gap. iOS draws nothing
/// of a Live Activity on its own, so this is the only place the brand appears.
/// Drawn on a 24-unit grid as stroked centre lines, cut and joined into one
/// filled outline, so any fill (the brand gradient or a state colour) applies.
struct PolythMark: Shape {
    static let center = CGPoint(x: 12, y: 11.1)
    static let radius: CGFloat = 6.8
    static let width: CGFloat = 4.3
    static let gap: CGFloat = 0.75
    static let tail: CGFloat = 2.2
    static let corner: CGFloat = 2.4

    func path(in rect: CGRect) -> Path {
        let vertex = { (degrees: CGFloat) -> CGPoint in
            let angle = degrees * .pi / 180
            return CGPoint(x: Self.center.x + Self.radius * cos(angle), y: Self.center.y + Self.radius * sin(angle))
        }
        let top = vertex(-90), upperRight = vertex(-30), lowerRight = vertex(30)
        let bottom = vertex(90), lowerLeft = vertex(150), upperLeft = vertex(210)
        let afterLowerLeft = Self.along(lowerLeft, bottom, Self.corner)
        let tailEnd = Self.along(bottom, lowerLeft, -Self.tail)

        // The right strand starts under the tail; the cut opens the gap there.
        let ring = Self.rounded([bottom, lowerRight, upperRight, top, upperLeft, lowerLeft, afterLowerLeft])
            .strokedPath(StrokeStyle(lineWidth: Self.width, lineJoin: .round))
        var tailLine = Path()
        tailLine.move(to: afterLowerLeft)
        tailLine.addLine(to: tailEnd)
        var cutLine = Path()
        cutLine.move(to: Self.along(bottom, lowerLeft, 1.6))
        cutLine.addLine(to: tailEnd)
        let tail = tailLine.strokedPath(StrokeStyle(lineWidth: Self.width, lineCap: .round))
        let cut = cutLine.strokedPath(StrokeStyle(lineWidth: Self.width + 2 * Self.gap, lineCap: .round))
        let outline = Path(ring.cgPath.subtracting(cut.cgPath).union(tail.cgPath))

        let scale = min(rect.width, rect.height) / 24
        return outline.applying(
            CGAffineTransform(translationX: rect.midX - 12 * scale, y: rect.midY - 12 * scale).scaledBy(x: scale, y: scale)
        )
    }

    /// The point `distance` from `from` towards `to` (negative: away from it).
    private static func along(_ from: CGPoint, _ to: CGPoint, _ distance: CGFloat) -> CGPoint {
        let dx = to.x - from.x, dy = to.y - from.y
        let length = (dx * dx + dy * dy).squareRoot()
        return CGPoint(x: from.x + dx / length * distance, y: from.y + dy / length * distance)
    }

    /// A polyline whose interior corners are rounded by `corner`.
    private static func rounded(_ points: [CGPoint]) -> Path {
        var path = Path()
        path.move(to: points[0])
        for index in 1..<(points.count - 1) {
            path.addLine(to: along(points[index], points[index - 1], corner))
            path.addQuadCurve(to: along(points[index], points[index + 1], corner), control: points[index])
        }
        path.addLine(to: points[points.count - 1])
        return path
    }
}

private func rgb(_ hex: UInt32) -> Color {
    Color(red: Double(hex >> 16 & 0xFF) / 255, green: Double(hex >> 8 & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
}

/// The app icon's colours, cyan at the top right to pink at the tail.
private var brandGradient: LinearGradient {
    LinearGradient(
        stops: [
            .init(color: rgb(0x16E0F7), location: 0),
            .init(color: rgb(0x2B5CFF), location: 0.45),
            .init(color: rgb(0x6A2BFF), location: 0.75),
            .init(color: rgb(0xE45CF2), location: 1),
        ],
        startPoint: UnitPoint(x: 0.83, y: 0.17),
        endPoint: UnitPoint(x: 0.21, y: 0.88)
    )
}

/// The brand mark at a fixed size, in the brand gradient unless a state colour
/// is given. Decorative unless given a label: wherever the status word or the
/// state glyph is visible, that carries the meaning.
private struct Mark: View {
    let size: CGFloat
    var tint: Color? = nil
    var label: String? = nil
    var body: some View {
        PolythMark()
            .fill(tint.map { AnyShapeStyle($0) } ?? AnyShapeStyle(brandGradient))
            .frame(width: size, height: size)
            .accessibilityLabel(Text(label ?? ""))
            .accessibilityHidden(label == nil)
    }
}

/// The state glyph shown beside the status word. Working has none: its label
/// and the elapsed timer say enough, and the mark is already there.
private func symbol(_ state: String) -> String? {
    switch state {
    case "needs-approval": return "checkmark.shield.fill"
    case "needs-reply": return "questionmark.bubble.fill"
    case "failed": return "exclamationmark.triangle.fill"
    case "done": return "checkmark.circle.fill"
    default: return nil
    }
}

private func stateTint(_ state: String) -> Color {
    switch state {
    case "needs-approval": return .orange
    case "needs-reply": return .cyan
    case "failed": return .red
    case "done": return .green
    default: return .white
    }
}

/// Status word with its state glyph, in the state's colour.
private struct StatusLabel: View {
    let state: State
    var body: some View {
        HStack(spacing: 4) {
            if let name = symbol(state.state) {
                Image(systemName: name).accessibilityHidden(true)
            }
            Text(state.label)
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(stateTint(state.state))
    }
}

/// Elapsed timer while working (drawn by the system, no per-second updates),
/// otherwise task progress or nothing.
private struct Trailing: View {
    let state: State
    var body: some View {
        if state.state == "working", let startedAt = state.startedAt {
            Text(timerInterval: startedAt...Date.distantFuture, countsDown: false)
                .monospacedDigit()
                .multilineTextAlignment(.trailing)
        } else if state.total > 0 {
            Text("\(state.done)/\(state.total)").monospacedDigit()
        } else {
            EmptyView()
        }
    }
}

/// Compact island, right side: the elapsed timer while working, otherwise the
/// state glyph, since the status word does not fit there.
private struct CompactTrailing: View {
    let state: State
    var body: some View {
        if let name = symbol(state.state) {
            Image(systemName: name)
                .foregroundStyle(stateTint(state.state))
                .accessibilityLabel(Text(state.label))
        } else {
            Trailing(state: state)
                .font(.caption2)
                .frame(maxWidth: 44)
        }
    }
}

private struct Details: View {
    let state: State
    let stale: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if !state.detail.isEmpty {
                Text(state.detail)
                    .font(.subheadline)
                    .lineLimit(2)
                    .privacySensitive()
            }
            if stale, !state.staleHint.isEmpty {
                Text(state.staleHint).font(.caption).foregroundStyle(.secondary)
            } else if !state.summary.isEmpty {
                Text(state.summary).font(.caption).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct LockScreen: View {
    let state: State
    let stale: Bool
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Mark(size: 30)
            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    StatusLabel(state: state)
                    Spacer(minLength: 8)
                    Trailing(state: state).font(.caption).foregroundStyle(.secondary)
                }
                Text(state.title).font(.headline).lineLimit(1).privacySensitive()
                Details(state: state, stale: stale)
            }
        }
        .padding(16)
        .opacity(stale ? 0.7 : 1)
    }
}

/// The mark leads every presentation in the brand gradient. The minimal
/// presentation has room for one shape only, so there the mark takes the
/// state's colour (the gradient while working).
struct PolythLiveActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: PolythActivityAttributes.self) { context in
            LockScreen(state: context.state, stale: context.isStale)
                .widgetURL(openURL(context.state))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Mark(size: 32).padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Trailing(state: context.state).font(.callout).foregroundStyle(.secondary)
                }
                DynamicIslandExpandedRegion(.center) {
                    VStack(spacing: 0) {
                        StatusLabel(state: context.state)
                        Text(context.state.title).font(.headline).lineLimit(1).privacySensitive()
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    Details(state: context.state, stale: context.isStale)
                }
            } compactLeading: {
                Mark(size: 20)
            } compactTrailing: {
                CompactTrailing(state: context.state)
            } minimal: {
                Mark(
                    size: 20,
                    tint: context.state.state == "working" ? nil : stateTint(context.state.state),
                    label: context.state.label
                )
            }
            .widgetURL(openURL(context.state))
            .keylineTint(stateTint(context.state.state))
        }
    }
}

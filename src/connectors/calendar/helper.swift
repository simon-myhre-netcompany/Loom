// EventKit helper for the Loom `calendar` connector.
//
// Reads Apple Calendar events in a date range and prints them as a JSON array
// to stdout. No network, no tokens — just local EventKit, gated by the standard
// macOS Calendar privacy permission (granted once in System Settings).
//
// Usage: calendar-helper --from YYYY-MM-DD --to YYYY-MM-DD
//
// Built with the embedded Info.plist (NSCalendars*UsageDescription) so the
// access request works from a plain command-line binary.

import EventKit
import Foundation

func arg(_ name: String) -> String? {
    let args = CommandLine.arguments
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

func parseDate(_ s: String?) -> Date? {
    guard let s = s else { return nil }
    let df = DateFormatter()
    df.dateFormat = "yyyy-MM-dd"
    df.timeZone = TimeZone.current
    return df.date(from: s)
}

func fail(_ message: String, _ code: Int32) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(code)
}

guard let start = parseDate(arg("--from")) else { fail("missing/invalid --from (YYYY-MM-DD)", 64) }
guard let toDay = parseDate(arg("--to")) else { fail("missing/invalid --to (YYYY-MM-DD)", 64) }
// Make --to inclusive of the whole day.
let end = Calendar.current.date(byAdding: .day, value: 1, to: toDay) ?? toDay

let store = EKEventStore()
let sema = DispatchSemaphore(value: 0)
var granted = false
var accessError: Error?

if #available(macOS 14.0, *) {
    store.requestFullAccessToEvents { ok, err in granted = ok; accessError = err; sema.signal() }
} else {
    store.requestAccess(to: .event) { ok, err in granted = ok; accessError = err; sema.signal() }
}
sema.wait()

guard granted else {
    fail("Calendar access not granted. Enable it in System Settings → Privacy & "
        + "Security → Calendars for your terminal."
        + (accessError != nil ? " (\(accessError!.localizedDescription))" : ""), 77)
}

let predicate = store.predicateForEvents(withStart: start, end: end, calendars: nil)
let events = store.events(matching: predicate)

let iso = ISO8601DateFormatter()
iso.formatOptions = [.withInternetDateTime]

let out: [[String: Any]] = events.map { e in
    var attendees: [String] = []
    if let parts = e.attendees {
        attendees = parts.compactMap { $0.name ?? $0.url.absoluteString }
    }
    return [
        "id": e.eventIdentifier ?? "",
        "title": e.title ?? "",
        "start": e.startDate != nil ? iso.string(from: e.startDate) : "",
        "end": e.endDate != nil ? iso.string(from: e.endDate) : "",
        "allDay": e.isAllDay,
        "calendar": e.calendar?.title ?? "",
        "location": e.location ?? "",
        "notes": e.notes ?? "",
        "url": e.url?.absoluteString ?? "",
        "organizer": e.organizer?.name ?? "",
        "attendees": attendees,
        "status": e.status.rawValue,
    ]
}

let data = try JSONSerialization.data(withJSONObject: out, options: [.sortedKeys])
FileHandle.standardOutput.write(data)

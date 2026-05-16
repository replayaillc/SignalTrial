import ApplicationServices
import Foundation

let keyNames: [Int64: String] = [
  0: "a", 1: "s", 2: "d", 3: "f", 4: "h", 5: "g", 6: "z", 7: "x", 8: "c", 9: "v",
  11: "b", 12: "q", 13: "w", 14: "e", 15: "r", 16: "y", 17: "t", 18: "1", 19: "2",
  20: "3", 21: "4", 22: "6", 23: "5", 24: "=", 25: "9", 26: "7", 27: "-", 28: "8",
  29: "0", 30: "]", 31: "o", 32: "u", 33: "[", 34: "i", 35: "p", 36: "return",
  37: "l", 38: "j", 39: "'", 40: "k", 41: ";", 42: "\\", 43: ",", 44: "/",
  45: "n", 46: "m", 47: ".", 48: "tab", 49: "space", 50: "`", 51: "delete",
  53: "escape", 55: "command", 56: "shift", 57: "caps-lock", 58: "option", 59: "control",
  60: "right-shift", 61: "right-option", 62: "right-control", 63: "function", 64: "f17",
  65: "keypad-decimal", 67: "keypad-multiply", 69: "keypad-plus", 71: "clear",
  72: "volume-up", 73: "volume-down", 74: "mute", 75: "keypad-divide", 76: "keypad-enter",
  78: "keypad-minus", 79: "f18", 80: "f19", 81: "keypad-equals", 82: "keypad-0",
  83: "keypad-1", 84: "keypad-2", 85: "keypad-3", 86: "keypad-4", 87: "keypad-5",
  88: "keypad-6", 89: "keypad-7", 90: "f20", 91: "keypad-8", 92: "keypad-9",
  96: "f5", 97: "f6", 98: "f7", 99: "f3", 100: "f8", 101: "f9", 103: "f11",
  105: "f13", 106: "f16", 107: "f14", 109: "f10", 111: "f12", 113: "f15",
  114: "help", 115: "home", 116: "page-up", 117: "forward-delete", 118: "f4",
  119: "end", 120: "f2", 121: "page-down", 122: "f1", 123: "left", 124: "right",
  125: "down", 126: "up"
]

func jsonEscape(_ value: String) -> String {
  var result = ""
  for scalar in value.unicodeScalars {
    switch scalar {
    case "\"": result += "\\\""
    case "\\": result += "\\\\"
    case "\n": result += "\\n"
    case "\r": result += "\\r"
    case "\t": result += "\\t"
    default:
      if scalar.value < 0x20 {
        result += String(format: "\\u%04x", scalar.value)
      } else {
        result.unicodeScalars.append(scalar)
      }
    }
  }
  return result
}

func modifiers(from flags: CGEventFlags) -> [String] {
  var names: [String] = []
  if flags.contains(.maskCommand) { names.append("command") }
  if flags.contains(.maskControl) { names.append("control") }
  if flags.contains(.maskAlternate) { names.append("option") }
  if flags.contains(.maskShift) { names.append("shift") }
  if flags.contains(.maskAlphaShift) { names.append("caps-lock") }
  if flags.contains(.maskSecondaryFn) { names.append("function") }
  return names
}

func characters(from event: CGEvent) -> String {
  var length = 0
  var chars = [UniChar](repeating: 0, count: 16)
  event.keyboardGetUnicodeString(maxStringLength: chars.count, actualStringLength: &length, unicodeString: &chars)
  return String(utf16CodeUnits: chars, count: length)
}

func writeLine(_ line: String) {
  if let data = "\(line)\n".data(using: .utf8) {
    FileHandle.standardOutput.write(data)
  }
}

func emitStatus(_ ok: Bool, _ message: String) {
  writeLine("{\"kind\":\"monitor-status\",\"ok\":\(ok),\"message\":\"\(jsonEscape(message))\",\"capturedAt\":\"\(ISO8601DateFormatter().string(from: Date()))\"}")
}

func callback(proxy: CGEventTapProxy, type: CGEventType, event: CGEvent, refcon: UnsafeMutableRawPointer?) -> Unmanaged<CGEvent>? {
  guard type == .keyDown || type == .keyUp || type == .flagsChanged else {
    return Unmanaged.passUnretained(event)
  }

  let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
  let flags = event.flags
  let modifierNames = modifiers(from: flags)
  let modifierJson = modifierNames.map { "\"\(jsonEscape($0))\"" }.joined(separator: ",")
  let kind = type == .keyDown ? "keydown" : (type == .keyUp ? "keyup" : "flagsChanged")
  let key = keyNames[keyCode] ?? "unknown"
  let text = characters(from: event)
  let isRepeat = event.getIntegerValueField(.keyboardEventAutorepeat) == 1
  let shortcut = (modifierNames + [key]).joined(separator: "+")

  writeLine(
    "{" +
      "\"kind\":\"\(kind)\"," +
      "\"keyCode\":\(keyCode)," +
      "\"key\":\"\(jsonEscape(key))\"," +
      "\"characters\":\"\(jsonEscape(text))\"," +
      "\"modifiers\":[\(modifierJson)]," +
      "\"shortcut\":\"\(jsonEscape(shortcut))\"," +
      "\"isRepeat\":\(isRepeat)," +
      "\"capturedAt\":\"\(ISO8601DateFormatter().string(from: Date()))\"" +
    "}"
  )

  return Unmanaged.passUnretained(event)
}

let mask =
  (1 << CGEventType.keyDown.rawValue) |
  (1 << CGEventType.keyUp.rawValue) |
  (1 << CGEventType.flagsChanged.rawValue)

let accessibilityTrusted = AXIsProcessTrusted()
emitStatus(true, accessibilityTrusted ? "Accessibility permission visible to keyboard helper" : "Keyboard helper continuing without direct Accessibility trust")

var inputMonitoringTrusted = true
if #available(macOS 10.15, *) {
  inputMonitoringTrusted = CGPreflightListenEventAccess()
  if inputMonitoringTrusted {
    emitStatus(true, "Input Monitoring permission granted")
  } else {
    emitStatus(false, "Input Monitoring permission needed for keyboard capture")
    inputMonitoringTrusted = CGRequestListenEventAccess()
  }
}

if !inputMonitoringTrusted {
  emitStatus(false, "Grant Input Monitoring permission to the keyboard helper, then restart recording.")
  exit(2)
}

guard let tap = CGEvent.tapCreate(
  tap: .cghidEventTap,
  place: .headInsertEventTap,
  options: .listenOnly,
  eventsOfInterest: CGEventMask(mask),
  callback: callback,
  userInfo: nil
) else {
  emitStatus(false, "Unable to create keyboard event tap. Grant Accessibility/Input Monitoring permission to SignalTrail or Electron.")
  exit(2)
}

let runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), runLoopSource, .commonModes)
CGEvent.tapEnable(tap: tap, enable: true)
emitStatus(true, "Keyboard monitor started")
CFRunLoopRun()

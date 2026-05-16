#include <ApplicationServices/ApplicationServices.h>
#include <napi.h>

#include <atomic>
#include <chrono>
#include <ctime>
#include <memory>
#include <sstream>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

namespace {

struct KeyboardPayload {
  bool status = false;
  bool ok = true;
  bool isRepeat = false;
  int64_t keyCode = 0;
  std::string kind;
  std::string key;
  std::string characters;
  std::vector<std::string> modifiers;
  std::string shortcut;
  std::string message;
  std::string capturedAt;
};

std::atomic<bool> running(false);
Napi::ThreadSafeFunction eventSink;
std::thread monitorThread;
CFMachPortRef eventTap = nullptr;
CFRunLoopRef monitorRunLoop = nullptr;

std::string isoTimestamp() {
  const auto now = std::chrono::system_clock::now();
  const auto time = std::chrono::system_clock::to_time_t(now);
  std::tm tm {};
  gmtime_r(&time, &tm);

  char buffer[32];
  std::strftime(buffer, sizeof(buffer), "%Y-%m-%dT%H:%M:%SZ", &tm);
  return buffer;
}

std::string keyName(int64_t keyCode) {
  static const std::unordered_map<int64_t, std::string> names = {
    {0, "a"}, {1, "s"}, {2, "d"}, {3, "f"}, {4, "h"}, {5, "g"}, {6, "z"}, {7, "x"},
    {8, "c"}, {9, "v"}, {11, "b"}, {12, "q"}, {13, "w"}, {14, "e"}, {15, "r"},
    {16, "y"}, {17, "t"}, {18, "1"}, {19, "2"}, {20, "3"}, {21, "4"}, {22, "6"},
    {23, "5"}, {24, "="}, {25, "9"}, {26, "7"}, {27, "-"}, {28, "8"}, {29, "0"},
    {30, "]"}, {31, "o"}, {32, "u"}, {33, "["}, {34, "i"}, {35, "p"}, {36, "return"},
    {37, "l"}, {38, "j"}, {39, "'"}, {40, "k"}, {41, ";"}, {42, "\\"}, {43, ","},
    {44, "/"}, {45, "n"}, {46, "m"}, {47, "."}, {48, "tab"}, {49, "space"},
    {50, "`"}, {51, "delete"}, {53, "escape"}, {55, "command"}, {56, "shift"},
    {57, "caps-lock"}, {58, "option"}, {59, "control"}, {60, "right-shift"},
    {61, "right-option"}, {62, "right-control"}, {63, "function"}, {64, "f17"},
    {65, "keypad-decimal"}, {67, "keypad-multiply"}, {69, "keypad-plus"}, {71, "clear"},
    {72, "volume-up"}, {73, "volume-down"}, {74, "mute"}, {75, "keypad-divide"},
    {76, "keypad-enter"}, {78, "keypad-minus"}, {79, "f18"}, {80, "f19"},
    {81, "keypad-equals"}, {82, "keypad-0"}, {83, "keypad-1"}, {84, "keypad-2"},
    {85, "keypad-3"}, {86, "keypad-4"}, {87, "keypad-5"}, {88, "keypad-6"},
    {89, "keypad-7"}, {90, "f20"}, {91, "keypad-8"}, {92, "keypad-9"}, {96, "f5"},
    {97, "f6"}, {98, "f7"}, {99, "f3"}, {100, "f8"}, {101, "f9"}, {103, "f11"},
    {105, "f13"}, {106, "f16"}, {107, "f14"}, {109, "f10"}, {111, "f12"},
    {113, "f15"}, {114, "help"}, {115, "home"}, {116, "page-up"},
    {117, "forward-delete"}, {118, "f4"}, {119, "end"}, {120, "f2"}, {121, "page-down"},
    {122, "f1"}, {123, "left"}, {124, "right"}, {125, "down"}, {126, "up"}
  };

  const auto match = names.find(keyCode);
  return match == names.end() ? "unknown" : match->second;
}

std::vector<std::string> modifiers(CGEventFlags flags) {
  std::vector<std::string> names;
  if (flags & kCGEventFlagMaskCommand) names.emplace_back("command");
  if (flags & kCGEventFlagMaskControl) names.emplace_back("control");
  if (flags & kCGEventFlagMaskAlternate) names.emplace_back("option");
  if (flags & kCGEventFlagMaskShift) names.emplace_back("shift");
  if (flags & kCGEventFlagMaskAlphaShift) names.emplace_back("caps-lock");
  if (flags & kCGEventFlagMaskSecondaryFn) names.emplace_back("function");
  return names;
}

std::string characters(CGEventRef event) {
  UniChar chars[16];
  UniCharCount length = 0;
  CGEventKeyboardGetUnicodeString(event, 16, &length, chars);
  return std::string([[NSString stringWithCharacters:chars length:length] UTF8String] ?: "");
}

std::string joinShortcut(const std::vector<std::string>& mods, const std::string& key) {
  std::ostringstream stream;

  for (const auto& mod : mods) {
    if (stream.tellp() > 0) stream << "+";
    stream << mod;
  }

  if (stream.tellp() > 0) stream << "+";
  stream << key;
  return stream.str();
}

void emit(std::unique_ptr<KeyboardPayload> payload) {
  if (!eventSink) {
    return;
  }

  auto* raw = payload.release();
  napi_status status = eventSink.NonBlockingCall(raw, [](Napi::Env env, Napi::Function callback, KeyboardPayload* payload) {
    std::unique_ptr<KeyboardPayload> owned(payload);
    Napi::Object event = Napi::Object::New(env);
    event.Set("kind", owned->kind);
    event.Set("capturedAt", owned->capturedAt);

    if (owned->status) {
      event.Set("ok", owned->ok);
      event.Set("message", owned->message);
    } else {
      event.Set("keyCode", Napi::Number::New(env, static_cast<double>(owned->keyCode)));
      event.Set("key", owned->key);
      event.Set("characters", owned->characters);
      event.Set("shortcut", owned->shortcut);
      event.Set("isRepeat", owned->isRepeat);

      Napi::Array mods = Napi::Array::New(env, owned->modifiers.size());
      for (size_t index = 0; index < owned->modifiers.size(); index += 1) {
        mods.Set(index, owned->modifiers[index]);
      }
      event.Set("modifiers", mods);
    }

    callback.Call({event});
  });

  if (status != napi_ok) {
    delete raw;
  }
}

void emitStatus(bool ok, const std::string& message) {
  auto payload = std::make_unique<KeyboardPayload>();
  payload->status = true;
  payload->ok = ok;
  payload->kind = "monitor-status";
  payload->message = message;
  payload->capturedAt = isoTimestamp();
  emit(std::move(payload));
}

CGEventRef tapCallback(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void* userInfo) {
  if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
    if (eventTap) {
      CGEventTapEnable(eventTap, true);
    }
    return event;
  }

  if (type != kCGEventKeyDown && type != kCGEventKeyUp && type != kCGEventFlagsChanged) {
    return event;
  }

  const int64_t code = CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode);
  auto mods = modifiers(CGEventGetFlags(event));
  auto key = keyName(code);

  auto payload = std::make_unique<KeyboardPayload>();
  payload->status = false;
  payload->kind = type == kCGEventKeyDown ? "keydown" : (type == kCGEventKeyUp ? "keyup" : "flagsChanged");
  payload->keyCode = code;
  payload->key = key;
  payload->characters = characters(event);
  payload->modifiers = mods;
  payload->shortcut = joinShortcut(mods, key);
  payload->isRepeat = CGEventGetIntegerValueField(event, kCGKeyboardEventAutorepeat) == 1;
  payload->capturedAt = isoTimestamp();
  emit(std::move(payload));

  return event;
}

void monitorLoop() {
  running = true;
  monitorRunLoop = CFRunLoopGetCurrent();

  const CGEventMask mask =
    CGEventMaskBit(kCGEventKeyDown) |
    CGEventMaskBit(kCGEventKeyUp) |
    CGEventMaskBit(kCGEventFlagsChanged);

  eventTap = CGEventTapCreate(
    kCGHIDEventTap,
    kCGHeadInsertEventTap,
    kCGEventTapOptionListenOnly,
    mask,
    tapCallback,
    nullptr
  );

  if (!eventTap) {
    emitStatus(false, "Unable to create native keyboard event tap. Check Input Monitoring permission for Electron/SignalTrail.");
    running = false;
    return;
  }

  CFRunLoopSourceRef source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, eventTap, 0);
  CFRunLoopAddSource(monitorRunLoop, source, kCFRunLoopCommonModes);
  CGEventTapEnable(eventTap, true);
  emitStatus(true, "Native keyboard monitor started");
  CFRunLoopRun();

  CFRunLoopRemoveSource(monitorRunLoop, source, kCFRunLoopCommonModes);
  CFRelease(source);
  CFRelease(eventTap);
  eventTap = nullptr;
  monitorRunLoop = nullptr;
  running = false;
}

Napi::Object permissionStatus(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object result = Napi::Object::New(env);
  result.Set("inputMonitoring", CGPreflightListenEventAccess() == true);
  return result;
}

Napi::Object start(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsFunction()) {
    Napi::TypeError::New(env, "start(callback) requires a callback").ThrowAsJavaScriptException();
    return Napi::Object::New(env);
  }

  Napi::Object result = Napi::Object::New(env);

  if (running) {
    result.Set("ok", true);
    result.Set("alreadyRunning", true);
    return result;
  }

  const bool trusted = CGPreflightListenEventAccess() == true || CGRequestListenEventAccess() == true;
  if (!trusted) {
    result.Set("ok", false);
    result.Set("permissionNeeded", true);
    result.Set("message", "Input Monitoring permission needed for Electron/SignalTrail.");
    return result;
  }

  eventSink = Napi::ThreadSafeFunction::New(
    env,
    info[0].As<Napi::Function>(),
    "SignalTrailKeyboardEvents",
    1024,
    1
  );

  monitorThread = std::thread(monitorLoop);
  result.Set("ok", true);
  return result;
}

Napi::Object stop(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (monitorRunLoop) {
    CFRunLoopStop(monitorRunLoop);
  }

  if (monitorThread.joinable()) {
    monitorThread.join();
  }

  if (eventSink) {
    eventSink.Release();
    eventSink = Napi::ThreadSafeFunction();
  }

  Napi::Object result = Napi::Object::New(env);
  result.Set("ok", true);
  return result;
}

Napi::Object init(Napi::Env env, Napi::Object exports) {
  exports.Set("permissionStatus", Napi::Function::New(env, permissionStatus));
  exports.Set("start", Napi::Function::New(env, start));
  exports.Set("stop", Napi::Function::New(env, stop));
  return exports;
}

NODE_API_MODULE(keyboard_monitor, init)

}  // namespace

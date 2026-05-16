{
  "targets": [
    {
      "target_name": "keyboard_monitor",
      "sources": ["src/native/keyboard-monitor.mm"],
      "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
      "dependencies": ["<!(node -p \"require('node-addon-api').gyp\")"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "xcode_settings": {
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
        "CLANG_CXX_LIBRARY": "libc++",
        "OTHER_LDFLAGS": [
          "-framework",
          "ApplicationServices",
          "-framework",
          "CoreGraphics"
        ]
      }
    }
  ]
}

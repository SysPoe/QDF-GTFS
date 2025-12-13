{
  "targets": [
    {
      "target_name": "gtfs_addon",
      "cflags!": [ "-fno-exceptions" ],
      "cflags_cc!": [ "-fno-exceptions" ],
      "cflags_cc": [ "-std=c++17" ],
      "xcode_settings": {
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17"
      },
      "msvs_settings": {
        "VCCLCompilerTool": {
          "AdditionalOptions": [ "/std:c++17" ]
        }
      },
      "sources": [
        "src/addon.cpp",
        "src/miniz.c",
        "src/nanopb/pb_common.c",
        "src/nanopb/pb_decode.c",
        "src/gtfs-realtime.pb.c"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "src"
      ],
      'defines': [ 'NAPI_DISABLE_CPP_EXCEPTIONS', '_CRT_SECURE_NO_WARNINGS', 'NOMINMAX' ],
    }
  ]
}

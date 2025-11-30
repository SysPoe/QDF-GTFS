{
  "targets": [
    {
      "target_name": "gtfs_addon",
      "cflags!": [ "-fno-exceptions" ],
      "cflags_cc!": [ "-fno-exceptions" ],
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
      'defines': [ 'NAPI_DISABLE_CPP_EXCEPTIONS' ],
    }
  ]
}
